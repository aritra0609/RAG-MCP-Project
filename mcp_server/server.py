import json
import chromadb
import sys
import contextlib
import os
from mcp.server.fastmcp import FastMCP
from backend.config import CHROMA_DB_DIR, EMBEDDING_MODEL

# Disable warnings and parallelism warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Redirect stdout to stderr during HuggingFace imports and model loading to protect the MCP stdio channel
with contextlib.redirect_stdout(sys.stderr):
    import logging
    logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
    
    from transformers import logging as transformers_logging
    transformers_logging.set_verbosity_error()
    
    from sentence_transformers import SentenceTransformer
    # Pre-load the model globally at startup
    model = SentenceTransformer('all-MiniLM-L6-v2')

# Initialize the FastMCP server
mcp = FastMCP("RAG_Context_Provider")

async def _query_vector_db(query: str, top_k: int = 5) -> str:
    """
    Helper function to search Chroma DB for semantic chunks matching query.
    """
    cleaned_query = query.strip()
    if not cleaned_query:
        return "[]"
        
    try:
        import asyncio
        
        # 1. Generate embedding for the question locally
        def _get_embedding():
            with contextlib.redirect_stdout(sys.stderr):
                return model.encode(cleaned_query.replace("\n", " ")).tolist()
            
        query_embedding = await asyncio.to_thread(_get_embedding)
 
        # 2. Query the Chroma database
        chroma_client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
        collection = chroma_client.get_or_create_collection(name="rag_documents")
        
        count = collection.count()
        if count == 0:
            return "[]"
 
        # Query top-k matches
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=min(top_k, count),
            include=["documents", "metadatas", "distances"]
        )
 
        # 3. Format and filter results based on distance
        output_chunks = []
        if results and "documents" in results and results["documents"] and len(results["documents"][0]) > 0:
            docs = results["documents"][0]
            metas = results["metadatas"][0]
            distances = results["distances"][0] if "distances" in results else [0.0] * len(docs)
 
            for doc, meta, dist in zip(docs, metas, distances):
                output_chunks.append({
                    "content": doc,
                    "source": meta.get("source", "unknown"),
                    "chunk_index": meta.get("chunk_index", -1),
                    "distance": float(dist)
                })
 
        return json.dumps(output_chunks)
 
    except Exception as e:
        return json.dumps({"error": f"MCP search failure: {str(e)}"})


@mcp.tool()
async def retrieve_context(query: str = "", openai_api_key: str = "", top_k: int = 5) -> str:
    """
    Retrieve the FULL raw document text.
    Use this tool at the very beginning of Step 1 to cache/access the entire document text.
    
    Args:
        query: Optional filename or matching string.
        openai_api_key: (Ignored)
        top_k: (Ignored)
    """
    try:
        from backend.database import get_indexed_documents, get_document_text
        doc_counts = get_indexed_documents()
        if not doc_counts:
            return "[]"
        
        # Select first document or match filename in query
        selected_doc = None
        cleaned_query = query.strip() if query else ""
        if cleaned_query:
            for doc in doc_counts.keys():
                if doc.lower() in cleaned_query.lower():
                    selected_doc = doc
                    break
        if not selected_doc:
            selected_doc = list(doc_counts.keys())[0]
            
        full_text = get_document_text(selected_doc)
        if not full_text:
            return "[]"
            
        # Return as a list containing a single dictionary with full text
        return json.dumps([{
            "content": full_text,
            "source": selected_doc,
            "chunk_index": 0,
            "distance": 0.0
        }])
    except Exception as e:
        return json.dumps({"error": f"Failed to retrieve full document: {str(e)}"})


@mcp.tool()
async def vector_search(query: str, top_k: int = 5) -> str:
    """
    Search the vector database for document chunks relevant to the user query.
    Use this tool whenever the user asks a question that requires document context.
 
    Args:
        query: The search query — rephrase it for best semantic match.
        top_k: Number of relevant chunks to retrieve (default 5).
    """
    return await _query_vector_db(query=query, top_k=top_k)


@mcp.tool()
async def summarize_text(text: str, max_words: int = 120) -> str:
    """
    Summarize a long piece of text into a concise summary.
    Use this tool when the user asks for a summary, or when retrieved text is too long to answer from directly.

    Args:
        text: The full text to summarize.
        max_words: Maximum number of words in the summary (default 120).
    """
    import httpx
    import asyncio

    OLLAMA_URL = "http://localhost:11434/api/generate"
    # Use the same model as the main backend
    try:
        from backend.config import LLM_MODEL
        model = LLM_MODEL
    except Exception:
        model = "llama3"

    # Split text into chunks of ~4000 chars
    words = text.split()
    chunk_size_words = 600  # ~4000 chars
    raw_chunks = []
    for i in range(0, len(words), chunk_size_words):
        raw_chunks.append(" ".join(words[i:i + chunk_size_words]))

    partial_summaries = []

    async with httpx.AsyncClient(timeout=180.0) as client:
        for idx, chunk in enumerate(raw_chunks):
            prompt = (
                f"<|system|>\nYou are a document summarizer. Summarize the text in 1-2 sentences.\n"
                f"<|user|>\nText:\n{chunk}\n\nProvide a 1-2 sentence summary.\n<|assistant|>\n"
            )
            try:
                resp = await client.post(
                    OLLAMA_URL,
                    json={"model": model, "prompt": prompt, "stream": False,
                          "options": {"num_predict": 150, "temperature": 0.2}},
                    timeout=180.0
                )
                if resp.status_code == 200:
                    partial = resp.json().get("response", "").strip()
                    if partial:
                        partial_summaries.append(partial)
            except Exception:
                continue

    if not partial_summaries:
        return "Could not summarize: no content could be extracted from the provided text."

    merged = "\n\n".join(partial_summaries)
    final_prompt = (
        f"<|system|>\nYou are a document summarizer. Merge the partial summaries into one coherent summary.\n"
        f"Rules:\n1. Maximum {max_words} words.\n2. Be professional and concise.\n"
        f"<|user|>\nPartial summaries:\n{merged}\n\nGenerate a final summary.\n<|assistant|>\n"
    )
    try:
        final_resp = await client.post(
            OLLAMA_URL,
            json={"model": model, "prompt": final_prompt, "stream": False,
                  "options": {"num_predict": max_words * 2, "temperature": 0.2}},
            timeout=180.0
        )
        if final_resp.status_code == 200:
            return final_resp.json().get("response", "").strip()
    except Exception as e:
        pass

    return merged  # Fall back to merged partials if final compression fails


@mcp.tool()
async def ocr_extract(file_id: str) -> str:
    """
    Extract text from an image-based or scanned document using OCR.
    Use this tool when the document appears to be image-based or when text extraction fails.

    Args:
        file_id: The filename or identifier of the document to extract text from.
    """
    # OCR is not yet implemented in this deployment.
    # Returning a clear message so the agent can inform the user.
    return json.dumps({
        "error": "ocr_not_available",
        "message": (
            f"OCR extraction for '{file_id}' is not available in this deployment. "
            "The document may be image-based. Please upload a text-based PDF or TXT file instead."
        )
    })


if __name__ == "__main__":
    mcp.run()
