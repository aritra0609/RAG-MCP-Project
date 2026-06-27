import io
import chromadb
from pypdf import PdfReader
from backend.config import CHROMA_DB_DIR, EMBEDDING_MODEL, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP

# Text Extraction Helper
def extract_text(file_bytes: bytes, filename: str) -> str:
    """
    Extracts plain text from raw file bytes based on file extension.
    Supports .txt and .pdf formats.
    """
    lower_filename = filename.lower()
    if lower_filename.endswith(".txt"):
        try:
            return file_bytes.decode("utf-8")
        except UnicodeDecodeError:
            # Fallback to latin-1 encoding if UTF-8 fails
            return file_bytes.decode("latin-1")
            
    elif lower_filename.endswith(".pdf"):
        pdf_file = io.BytesIO(file_bytes)
        reader = PdfReader(pdf_file)
        text_parts = []
        for i, page in enumerate(reader.pages):
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
        return "\n\n".join(text_parts)
        
    else:
        raise ValueError("Unsupported file format. Only .pdf and .txt files are supported.")

# Custom Sliding-Window Text Splitter (Zero LangChain)
def chunk_text(text: str, chunk_size: int = DEFAULT_CHUNK_SIZE, chunk_overlap: int = DEFAULT_CHUNK_OVERLAP) -> list[str]:
    """
    Splits input text into overlapping chunks using a sliding window.
    """
    chunks = []
    if not text:
        return chunks
        
    # We do character-based chunking with sliding window
    step = chunk_size - chunk_overlap
    if step <= 0:
        step = chunk_size
        
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += step
        
    return chunks

# Batch Embedding Generation
async def generate_embeddings(chunks: list[str], api_key: str = None) -> list[list[float]]:
    """
    Generates text embeddings locally using sentence-transformers (all-MiniLM-L6-v2).
    """
    import asyncio
    from sentence_transformers import SentenceTransformer
    
    def _encode():
        # Loads sentence-transformers model locally
        model = SentenceTransformer('all-MiniLM-L6-v2')
        cleaned_chunks = [c.replace("\n", " ") for c in chunks]
        return [emb.tolist() for emb in model.encode(cleaned_chunks)]
        
    return await asyncio.to_thread(_encode)

# Document Ingestion Flow
async def add_documents_to_db(file_bytes: bytes, filename: str, api_key: str = None) -> int:
    """
    Extracts, chunks, embeds, and stores a document in the Chroma vector database.
    Returns the number of chunks added.
    """
    # 1. Extract text
    text = extract_text(file_bytes, filename)
    if not text.strip():
        raise ValueError(f"No readable text found in document: {filename}")
        
    # 2. Chunk text
    chunks = chunk_text(text)
    if not chunks:
        raise ValueError(f"Document {filename} was split into 0 chunks.")
        
    # 3. Generate embeddings
    embeddings = await generate_embeddings(chunks, api_key)
    
    # 4. Save to Chroma DB
    # Create persistent client inside function to prevent persistent locking between processes
    chroma_client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
    collection = chroma_client.get_or_create_collection(name="rag_documents")
    
    ids = [f"{filename}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [{"source": filename, "chunk_index": i} for i in range(len(chunks))]
    
    collection.add(
        ids=ids,
        embeddings=embeddings,
        documents=chunks,
        metadatas=metadatas
    )
    
    return len(chunks)

# Retrieve Document List
def get_indexed_documents() -> dict[str, int]:
    """
    Queries Chroma DB to count the chunks stored for each unique source document name.
    """
    chroma_client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
    collection = chroma_client.get_or_create_collection(name="rag_documents")
    
    results = collection.get(include=["metadatas"])
    doc_counts = {}
    if results and "metadatas" in results and results["metadatas"]:
        for meta in results["metadatas"]:
            if meta and "source" in meta:
                source = meta["source"]
                doc_counts[source] = doc_counts.get(source, 0) + 1
    return doc_counts

# Clear Database Index
def clear_vector_db():
    """
    Deletes and recreates the documents collection, freeing database records.
    """
    chroma_client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
    try:
        chroma_client.delete_collection(name="rag_documents")
    except Exception:
        # Collection might not exist yet, ignore error
        pass
    chroma_client.get_or_create_collection(name="rag_documents")


# Reconstruct Full Document Text
def get_document_text(filename: str) -> str:
    """
    Retrieves and reconstructs the full text of an indexed document from Chroma DB
    by sorting its chunks by chunk_index.
    """
    chroma_client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
    collection = chroma_client.get_or_create_collection(name="rag_documents")
    
    results = collection.get(
        where={"source": filename},
        include=["documents", "metadatas"]
    )
    
    if results and "documents" in results and results["documents"]:
        chunks_with_idx = []
        for doc, meta in zip(results["documents"], results["metadatas"]):
            if meta and "chunk_index" in meta:
                chunks_with_idx.append((meta["chunk_index"], doc))
            else:
                chunks_with_idx.append((0, doc))
        
        # Sort by chunk_index
        chunks_with_idx.sort(key=lambda x: x[0])
        
        # Reconstruct the document content
        full_text = "\n\n".join([chunk for _, chunk in chunks_with_idx])
        return full_text
    return ""


# Match and Retrieve Document for Summary
def get_document_text_for_summary(query: str) -> tuple[str, str]:
    """
    Looks at the list of indexed documents in Chroma DB, determines which document
    the user is referring to (or defaults to the first one), and returns
    a tuple of (filename, full_text). If no documents are found, returns ("", "").
    """
    doc_counts = get_indexed_documents()
    if not doc_counts:
        return "", ""
        
    # Check if any document name is mentioned in the query
    selected_doc = None
    for doc in doc_counts.keys():
        if doc.lower() in query.lower():
            selected_doc = doc
            break
            
    # Default to the first document in the database if no name is mentioned
    if not selected_doc:
        selected_doc = list(doc_counts.keys())[0]
        
    full_text = get_document_text(selected_doc)
    return selected_doc, full_text

