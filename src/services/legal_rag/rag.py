import asyncio
import os
from typing import TypedDict, Annotated, Sequence
from openai import AsyncOpenAI
from pymilvus import MilvusClient
from langgraph.graph import StateGraph, END
from duckduckgo_search import DDGS
from dotenv import load_dotenv

load_dotenv()

# Initialize OpenAI client
api_key = os.getenv("OPENAI_API_KEY")
client = AsyncOpenAI(api_key=api_key) if api_key else None

# Initialize Milvus Lite
milvus_client = MilvusClient("./milvus_demo.db")

class AgentState(TypedDict):
    question: str
    document_id: str
    context: list[str]
    web_context: list[str]
    answer: str
    loop_count: int
    is_relevant: bool

# Node: Retrieve context from Milvus
async def retrieve(state: AgentState):
    query = state["question"]
    doc_id = state["document_id"]
    
    emb_response = await client.embeddings.create(
        model="text-embedding-3-small",
        input=[query]
    )
    query_vector = emb_response.data[0].embedding
    
    retrieved_texts = []
    try:
        milvus_client.load_collection("legal_clauses")
        search_res = milvus_client.search(
            collection_name="legal_clauses",
            data=[query_vector],
            limit=10,
            output_fields=["text", "doc_id", "page_index"]
        )
        for hits in search_res:
            for hit in hits:
                entity = hit["entity"]
                page = entity.get("page_index", 1)
                text = entity.get("text", "")
                retrieved_texts.append(f"[Page {page}] {text}")
    except Exception as e:
        print(f"Milvus search error: {e}")
        
    return {"context": retrieved_texts, "loop_count": state.get("loop_count", 0) + 1}

# Node: Grade the retrieved documents
async def grade(state: AgentState):
    context = "\n".join(state.get("context", []))
    query = state["question"]
    
    prompt = f"Does the following context contain information related to the question '{query}'? You MUST use your general world knowledge to match acronyms (e.g. SCDP = Sterling Cooper Draper Pryce). Reply YES or NO.\n\nContext:\n{context}"
    completion = await client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0
    )
    
    evaluation = completion.choices[0].message.content.strip().upper()
    state["is_relevant"] = "YES" in evaluation
    return state

# Conditional Routing Function
def decide_next(state: AgentState) -> str:
    # If the LLM graded the context as irrelevant, rewrite and try again
    if not state.get("is_relevant"):
        if state.get("loop_count", 0) > 1:
            return "web_search" # Fallback to web search
        return "rewrite"
    return "generate"

# Node: Rewrite the query if context is bad
async def rewrite(state: AgentState):
    query = state["question"]
    completion = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "You are an expert query rewriting assistant. Use your general knowledge to expand or compress acronyms (e.g., Sterling Cooper Draper Pryce -> SCDP). Extract key entities and rewrite the user's query to be a highly effective semantic search string. Return ONLY the new string."},
            {"role": "user", "content": f"Query: {query}"}
        ],
        temperature=0.0
    )
    rewritten = completion.choices[0].message.content
    return {"question": rewritten}

# Node: Web Search Fallback
async def web_search(state: AgentState):
    query = state["question"]
    web_results = []
    try:
        def search():
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=3))
                return [res["body"] for res in results]
        web_results = await asyncio.to_thread(search)
    except Exception as e:
        print(f"Web search error: {e}")
        
    return {"web_context": web_results}

# Node: Generate final answer
async def generate(state: AgentState):
    context = "\n".join(state.get("context", []))
    web_context = "\n".join(state.get("web_context", []))
    
    combined_context = f"--- Document Context ---\n{context if context else 'None'}\n\n"
    if web_context:
        combined_context += f"--- Web Search Context (Live Internet) ---\n{web_context}\n\n"
        
    query = state["question"]
    
    system_prompt = (
        "You are an expert AI Legal Agent. Use the provided context to accurately answer the user's question. "
        "The context may contain local Document Context, and if the document failed to answer the question, it may contain live Web Search Context. "
        "You are explicitly permitted to use your general world knowledge to match acronyms in the context to entities in the question (e.g., SCDP = Sterling Cooper Draper Pryce). "
        "If you use web search context to answer the question, explicitly mention that you researched this on the live web since it was not in the document. "
        "If the answer is not contained in either context, say you do not know based on the provided documents."
    )
    
    completion = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Context: {combined_context}\n\nQuestion: {query}"}
        ],
        temperature=0.0
    )
    answer = completion.choices[0].message.content
    return {"answer": answer}

# Build LangGraph StateGraph
workflow = StateGraph(AgentState)
workflow.add_node("retrieve", retrieve)
workflow.add_node("grade", grade)
workflow.add_node("rewrite", rewrite)
workflow.add_node("web_search", web_search)
workflow.add_node("generate", generate)

# Define Graph Flow
workflow.set_entry_point("retrieve")
workflow.add_edge("retrieve", "grade")
workflow.add_conditional_edges(
    "grade", 
    decide_next, 
    {
        "generate": "generate", 
        "rewrite": "rewrite", 
        "web_search": "web_search"
    }
)
workflow.add_edge("rewrite", "retrieve")
workflow.add_edge("web_search", "generate")
workflow.add_edge("generate", END)

# Compile Graph
app = workflow.compile()

async def process_agent_query(query: str, document_id: str) -> str:
    """
    Invokes the compiled LangGraph workflow.
    """
    final_state = await app.ainvoke({
        "question": query, 
        "document_id": document_id, 
        "loop_count": 0
    })
    
    # Save debug info
    with open("debug_rag.txt", "w", encoding="utf-8") as f:
        f.write(f"Final Query Used: {final_state.get('question')}\n\n")
        f.write(f"Document Context:\n{final_state.get('context', [])}\n\n")
        f.write(f"Web Context:\n{final_state.get('web_context', [])}\n\n")
        f.write(f"Answer Generated:\n{final_state.get('answer', '')}\n")
        f.write(f"Loop Count:\n{final_state.get('loop_count')}\n")
        
    return final_state.get("answer", "I do not have enough information.")
