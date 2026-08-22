import fitz
import io
import base64
import asyncio
import os
from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("OPENAI_API_KEY")
openai_client = AsyncOpenAI(api_key=api_key) if api_key else None

async def extract_text_from_image(image_bytes: bytes) -> str:
    base64_image = base64.b64encode(image_bytes).decode('utf-8')
    try:
        response = await openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Extract all text from this document image exactly as written. Do not add any conversational text or markdown formatting outside of the extracted text."},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{base64_image}",
                                "detail": "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens=2000
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"OpenAI OCR Error: {e}")
        return ""

async def perform_ocr(file_content: bytes, filename: str) -> list:
    """
    Real Document Parsing Service.
    Uses PyMuPDF for digital text, and OpenAI Vision API for scanned images/PDFs.
    Checks file magic bytes to support files without extensions.
    Returns a list of dictionaries: [{"text": str, "page_index": int}]
    """
    pages = []
    try:
        if file_content.startswith(b'%PDF'):
            doc = fitz.open(stream=file_content, filetype="pdf")
            for i, page in enumerate(doc):
                page_text = page.get_text().strip()
                # Count actual readable letters/numbers
                alnum_count = sum(c.isalnum() for c in page_text)
                if alnum_count > 250:
                    pages.append({"text": page_text, "page_index": i + 1})
                else:
                    # Fallback to OCR if page has very little digital text
                    pix = page.get_pixmap()
                    img_bytes = pix.tobytes("png")
                    img_text = await extract_text_from_image(img_bytes)
                    pages.append({"text": img_text, "page_index": i + 1})
            doc.close()
        elif file_content.startswith((b'\x89PNG', b'\xff\xd8', b'GIF8', b'BM', b'RIFF')):
            text = await extract_text_from_image(file_content)
            pages.append({"text": text.strip(), "page_index": 1})
        else:
            text = file_content.decode('utf-8')
            pages.append({"text": text.strip(), "page_index": 1})
    except Exception as e:
        print(f"Error parsing document: {e}")
        pages.append({"text": f"Error extracting text: {e}", "page_index": 1})
        
    return pages
