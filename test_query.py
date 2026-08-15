from pymilvus import MilvusClient
c = MilvusClient('./data/milvus.db')
try:
    c.load_collection('unstructured_rag')
    res = c.query('unstructured_rag', filter="source == '26359791_Policy_Document.pdf'", output_fields=['text'])
    print(f'Found {len(res)} chunks')
    if res:
        print('Example text:', repr(res[0].get('text', '')))
except Exception as e:
    print("Error:", e)
