import os
import sys
import json
import logging
import asyncio
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# MCP Client SDK Imports
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Local Imports
from backend.config import BASE_DIR, get_api_key, LLM_MODEL
from backend.database import add_documents_to_db, get_indexed_documents, clear_vector_db

# Set up logging to show the MCP and RAG logic in the server terminal
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout
)
logger = logging.getLogger("RAG-Backend")

class RAGException(Exception):
    def __init__(self, error_code: str, message: str, suggestion: str, status_code: int = 500):
        self.error_code = error_code
        self.message = message
        self.suggestion = suggestion
        self.status_code = status_code
        super().__init__(message)

app = FastAPI(title="MCP-RAG Backend", version="1.0.0")

@app.exception_handler(RAGException)
async def rag_exception_handler(request: Request, exc: RAGException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "error_code": exc.error_code,
            "message": exc.message,
            "suggestion": exc.suggestion
        }
    )

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "error_code": "INVALID_REQUEST" if exc.status_code in (400, 422) else "HTTP_ERROR",
            "message": str(exc.detail),
            "suggestion": "Please verify your input parameters and try again."
        }
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled system error: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error_code": "UNKNOWN_ERROR",
            "message": "An unexpected error occurred while processing your request.",
            "suggestion": "Please refresh the page and try again. If this continues, restart the backend server."
        }
    )

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    question: str

# Configure MCP Server Process parameters
# Uses sys.executable to run the MCP server subprocess inside the same python environment
server_params = StdioServerParameters(
    command=sys.executable,
    args=["-u", "-m", "mcp_server.server"],
    env={"PYTHONPATH": str(BASE_DIR), **os.environ}
)

# ─────────────────────────────────────────────────────────────────────────────
# AGENTIC RAG — Constants & Helpers
# ─────────────────────────────────────────────────────────────────────────────

MAX_TOOL_CALLS = 5  # Safety cap to prevent infinite agent loops

AGENT_SYSTEM_PROMPT = (
    "You are a NON-AGENTIC, DOCUMENT-GROUNDED RAG ASSISTANT.\n\n"
    "IMPORTANT:\n"
    "• You are NOT an AI Agent.\n"
    "• You do NOT decide tools, routing, retries, or workflows.\n"
    "• You do NOT perform multi-step reasoning or planning.\n"
    "• All control logic is handled by the backend.\n"
    "• Your only responsibility is to generate accurate language output.\n"
    "It should use model context protocol.\n\n"
    "DOCUMENT USAGE RULES (STRICT):\n"
    "1. You will always receive FULL document content from the backend.\n"
    "2. You MUST answer strictly using the provided document text.\n"
    "3. NEVER assume, infer, guess, or hallucinate information.\n"
    "4. If the answer is not explicitly present in the document, respond exactly:\n"
    "   \"The requested information is not present in the document.\"\n\n"
    "QUESTION ANSWERING MODE:\n"
    "• When a user asks a question about the document:\n"
    "  – Extract the answer verbatim or semantically from the document.\n"
    "  – Be precise, concise, and factual.\n"
    "  – Do NOT summarize unless explicitly asked.\n\n"
    "SUMMARIZATION MODE:\n"
    "• When the user asks to summarize:\n"
    "  – Summarize ONLY the provided document text.\n"
    "  – Respect the requested minimum word count exactly.\n"
    "  – If a minimum word count is specified (e.g., more than 100 words),\n"
    "    your output MUST meet or exceed that count.\n"
    "  – Longer is acceptable. Shorter is NOT.\n"
    "  – Do NOT introduce new information.\n\n"
    "OUTPUT FORMAT RULES (MANDATORY):\n"
    "• Output MUST be plain text only.\n"
    "• NO JSON.\n"
    "• NO markdown.\n"
    "• NO explanations.\n"
    "• NO tool calls.\n"
    "• NO assumptions.\n"
    "• NO agent commentary.\n\n"
    "PERFORMANCE RULE:\n"
    "• Produce a single, direct response.\n"
    "• No retries.\n"
    "• No self-correction loops.\n\n"
    "FAIL-SAFE:\n"
    "If document content is missing or empty, respond exactly:\n"
    "\"ERROR: Document content not available.\"\n\n"
    "Remember:\n"
    "You are a deterministic RAG responder, NOT an AI agent."
)

AGENT_TOOL_STATUS_MAP = {
    "vector_search": "\U0001f50d Searching document\u2026",
    "summarize_text": "\u270d\ufe0f Summarizing content\u2026",
    "ocr_extract": "\U0001f4f7 Reading image\u2026",
    "retrieve_context": "\U0001f4c4 Fetching full document\u2026",
}


# Registry of all MCP tool names the agent is allowed to call.
# Used to detect intent-based tool calls (where "action" IS the tool name).
MCP_TOOL_REGISTRY = {"vector_search", "summarize_text", "ocr_extract", "retrieve_context"}


def _parse_agent_response(raw_text: str, user_query: str) -> dict | None:
    """
    Attempts to parse a structured agent decision from a raw LLM text response.

    Accepts two formats:
      1. Canonical:    {"action": "tool", "tool": "<name>", "args": {...}}
      2. Intent-based: {"action": "<tool_name>", ...remaining fields as args...}
      3. Final answer: {"action": "answer", "text": "..."}

    Returns a parsed decision dict, or None if parsing fails.
    """
    import re

    # Strip markdown code fences (```json ... ``` or ``` ... ```)
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_text).replace("```", "").strip()

    # Find the outermost JSON object (greedy, handles nested braces via last })
    json_match = re.search(r"\{[\s\S]*\}", cleaned)
    if not json_match:
        return None

    try:
        parsed = json.loads(json_match.group(0))
    except json.JSONDecodeError:
        return None

    action = parsed.get("action", "").strip().lower()

    # Format 1 & 3: action is a keyword ("tool" or "answer")
    if action == "tool":
        tool_name = parsed.get("tool", "").strip()
        if tool_name in MCP_TOOL_REGISTRY:
            return {
                "type": "tool_call",
                "tool": tool_name,
                "args": parsed.get("args", {})
            }
        # "action":"tool" with unknown tool name — treat as error signal
        return {"type": "final_answer", "text": parsed.get("text", raw_text)}

    if action == "answer":
        return {"type": "final_answer", "text": parsed.get("text", raw_text)}

    # Format 2: "action" field contains the tool name directly
    # e.g. {"action": "summarize_text", "text": "...", "max_words": 120}
    # Or {"action": "summarize_text", "args": {"text": "...", "max_words": 120}}
    if action in MCP_TOOL_REGISTRY:
        args = {}
        # If there is a nested "args" dictionary, extract from it
        if isinstance(parsed.get("args"), dict):
            args.update(parsed["args"])
        # Also merge top-level keys except "action" and "args"
        for k, v in parsed.items():
            if k not in ("action", "args"):
                args[k] = v

        # Enforce query for vector_search
        if action == "vector_search":
            query_val = str(args.get("query", "")).strip()
            if not query_val:
                args["query"] = user_query

        return {
            "type": "tool_call",
            "tool": action,
            "args": args
        }

    # Fallback A: action == "input" — llama3 uses this as a "request data" signal.
    # Three sub-patterns observed in the wild:
    if action == "input":

        # A1: has a non-empty "text" field → LLM wants to summarize that text
        text_val = parsed.get("text", "").strip()
        if text_val:
            max_words = parsed.get("max_words", 120)
            logger.debug("Parser: action='input' + text → summarize_text")
            return {
                "type": "tool_call",
                "tool": "summarize_text",
                "args": {"text": text_val, "max_words": max_words}
            }

        # A2: has a "tool" field — LLM is naming what it wants to retrieve/run
        tool_hint = str(parsed.get("tool", "")).lower()
        if tool_hint:
            # A2a: the named tool is directly in our MCP registry → use it
            if tool_hint in MCP_TOOL_REGISTRY:
                args = parsed.get("args") or {}
                if not isinstance(args, dict):
                    args = {}
                logger.debug(f"Parser: action='input' + tool='{tool_hint}' → direct MCP call")
                return {"type": "tool_call", "tool": tool_hint, "args": args}

            # A2b: the name hints at document/text/content retrieval → vector_search
            RETRIEVAL_HINTS = {"document", "text", "content", "doc", "file", "page", "chunk"}
            if any(h in tool_hint for h in RETRIEVAL_HINTS):
                inner_args = parsed.get("args") or {}
                if not isinstance(inner_args, dict):
                    inner_args = {}
                query = (
                    inner_args.get("query")
                    or parsed.get("query")
                    or user_query
                )
                logger.debug(
                    f"Parser: action='input' + tool='{tool_hint}' hints at retrieval → vector_search"
                )
                return {
                    "type": "tool_call",
                    "tool": "vector_search",
                    "args": {"query": query, "top_k": 5}
                }

        # A3: no text and no useful tool hint — fall through to retry
        logger.debug("Parser: action='input' — no text or useful tool hint, will retry.")

    # Fallback B: any other unrecognized action that still has a non-empty "text" field.
    # The LLM wrapped a final answer in an unexpected envelope — surface the text directly.
    text_val = parsed.get("text", "").strip()
    if text_val:
        logger.warning(
            f"Parser: unrecognized action='{action}' but found text field — "
            "treating as final answer."
        )
        return {"type": "final_answer", "text": text_val}

    # JSON parsed but no recognisable structure and no text field — trigger retry
    return None


async def call_ollama_with_tools(messages: list[dict], user_query: str, _is_retry: bool = False) -> dict:
    """
    Calls Ollama /api/chat in non-streaming JSON mode.
    Returns parsed agent decision: {"type": "tool_call", "tool": ..., "args": ...}
    or {"type": "final_answer", "text": ...}.

    On parse failure, retries once with a corrective prompt before giving up.
    """
    import httpx

    url = "http://localhost:11434/api/chat"
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": 512, "temperature": 0.1}
    }

    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(url, json=payload, timeout=180.0)
        if response.status_code != 200:
            raise RAGException(
                error_code="LLM_ERROR",
                message="The language model returned an unexpected error.",
                suggestion="Make sure Ollama is running and the model is installed.",
                status_code=500
            )
        data = response.json()

    # Extract raw text from the chat response (/api/chat puts it in message.content)
    raw_text = ""
    msg = data.get("message", {})
    if isinstance(msg, dict):
        raw_text = msg.get("content", "").strip()
    if not raw_text:
        raw_text = data.get("response", "").strip()

    logger.info(f"Agent raw response: {raw_text[:300]}")

    # Attempt structured parse
    decision = _parse_agent_response(raw_text, user_query)

    if decision is not None:
        if decision["type"] == "tool_call":
            logger.info(f"Agent decided to call tool: '{decision['tool']}' with args: {decision['args']}")
        else:
            logger.info("Agent decided to return a final answer.")
        return decision

    # Parse failed — retry once with a corrective prompt (unless already retrying)
    if not _is_retry:
        logger.warning(
            f"Agent response could not be parsed — retrying with corrective prompt. "
            f"Raw: {raw_text[:200]}"
        )
        retry_messages = messages + [
            {
                "role": "assistant",
                "content": raw_text
            },
            {
                "role": "user",
                "content": (
                    "Your previous response was not valid JSON. "
                    "You MUST respond with ONLY a JSON object. No prose. No explanation.\n"
                    "To call a tool: {\"action\": \"tool\", \"tool\": \"<name>\", \"args\": {<key-value pairs>}}\n"
                    "To give a final answer: {\"action\": \"answer\", \"text\": \"<your answer>\"}"
                )
            }
        ]
        return await call_ollama_with_tools(retry_messages, user_query, _is_retry=True)

    # Both attempts failed — return a safe user-facing error
    logger.error(f"Agent failed to produce valid JSON after retry. Raw: {raw_text[:300]}")
    return {
        "type": "error",
        "error_code": "LLM_ERROR",
        "message": "The AI agent could not determine the next step. This may be a model compatibility issue.",
        "suggestion": "Please try again. If the problem persists, check that your Ollama model supports instruction following."
    }



async def execute_mcp_tool(session, tool_name: str, args: dict) -> str:
    """
    Dispatches a tool call to the MCP server and returns the result string.
    """
    allowed_tools = {"vector_search", "summarize_text", "ocr_extract", "retrieve_context"}
    if tool_name not in allowed_tools:
        return json.dumps({"error": f"Unknown tool '{tool_name}'. Available: {list(allowed_tools)}"})

    try:
        logger.info(f"Executing MCP tool '{tool_name}' with args: {args}")
        result = await session.call_tool(tool_name, arguments=args)
        tool_output = ""
        for content in result.content:
            if content.type == "text":
                tool_output += content.text
        logger.info(f"MCP tool '{tool_name}' returned {len(tool_output)} chars.")
        return tool_output
    except Exception as tool_err:
        logger.error(f"MCP tool '{tool_name}' execution failed: {tool_err}")
        return json.dumps({"error": f"Tool '{tool_name}' failed: {str(tool_err)}"})


async def stream_agent_loop(question: str):
    """
    Non-agentic, document-grounded RAG control loop.
    Backend retrieves the document via MCP session, formats the context,
    and streams the direct plain-text LLM completion.
    """
    try:
        # 1. Start MCP stdio client session
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                
                # Yield Status: Fetching full document
                _status = json.dumps({"agent_status": "\u23f3 Fetching document content\u2026"})
                yield f"data: {_status}\n\n"
                await asyncio.sleep(0.05)
                
                # 2. Call retrieve_context via MCP to get the full raw document text
                tool_result = ""
                try:
                    result = await session.call_tool("retrieve_context", arguments={})
                    for content in result.content:
                        if content.type == "text":
                            tool_result += content.text
                except Exception as e:
                    logger.error(f"Failed to retrieve context via MCP: {e}")
                
                # Parse JSON array returned by retrieve_context
                full_text = ""
                if tool_result:
                    try:
                        parsed = json.loads(tool_result)
                        if isinstance(parsed, list) and len(parsed) > 0:
                            full_text = parsed[0].get("content", "").strip()
                    except Exception as e:
                        logger.error(f"Failed to parse retrieve_context JSON: {e}")
                
                # Fail-safe check
                if not full_text:
                    _clear = json.dumps({"agent_status": ""})
                    yield f"data: {_clear}\n\n"
                    _pkt = json.dumps({"content": "ERROR: Document content not available."})
                    yield f"data: {_pkt}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                
                # Yield Status: Generating response
                _status = json.dumps({"agent_status": "\U0001f4dd Generating response\u2026"})
                yield f"data: {_status}\n\n"
                await asyncio.sleep(0.05)
                
                # 3. Format prompt for Ollama completion
                # System prompt is the exact prompt supplied by the user
                prompt = (
                    f"<|system|>\n{AGENT_SYSTEM_PROMPT}\n"
                    f"<|user|>\nDocument Content:\n{full_text}\n\n"
                    f"User Question:\n{question}\n"
                    f"<|assistant|>\n"
                )
                
                url = "http://localhost:11434/api/generate"
                payload = {
                    "model": LLM_MODEL,
                    "prompt": prompt,
                    "stream": True,
                    "options": {
                        "temperature": 0.1
                    }
                }
                
                # Clear status indicator
                _clear = json.dumps({"agent_status": ""})
                yield f"data: {_clear}\n\n"
                
                # 4. Stream Ollama completion response directly
                import httpx
                async with httpx.AsyncClient(timeout=180.0) as client:
                    async with client.stream("POST", url, json=payload, timeout=180.0) as response:
                        if response.status_code != 200:
                            error_text = await response.aread()
                            raise Exception(f"Ollama returned status {response.status_code}: {error_text.decode()}")
                        
                        async for line in response.aiter_lines():
                            if not line:
                                continue
                            try:
                                data = json.loads(line)
                                content = data.get("response", "")
                                if content:
                                    _pkt = json.dumps({"content": content})
                                    yield f"data: {_pkt}\n\n"
                                if data.get("done", False):
                                    break
                            except json.JSONDecodeError:
                                continue
                                
                yield "data: [DONE]\n\n"
                logger.info("RAG streaming completion completed successfully.")
                
    except Exception as e:
        logger.error(f"RAG system error: {str(e)}", exc_info=True)
        # Use our standard error formatting for client UX safety
        err_payload = json.dumps({
            "success": False,
            "error_code": "UNKNOWN_ERROR",
            "message": "An error occurred while generating the response.",
            "suggestion": "Please try sending your message again."
        })
        yield f"data: {err_payload}\n\n"
        yield "data: [DONE]\n\n"

@app.post("/api/upload")
@app.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    """
    Ingests a PDF or TXT file, chunks it, generates embeddings, and saves to Chroma DB.
    """

    filename = file.filename
    logger.info(f"Received file upload request: {filename}")
    
    try:
        # Read file bytes
        file_bytes = await file.read()
        
        # Process and store in database
        chunks_count = await add_documents_to_db(file_bytes, filename)
        
        logger.info(f"Ingestion successful! Added {chunks_count} chunks for {filename}")
        return {"status": "success", "filename": filename, "chunks": chunks_count}
        
    except ValueError as ve:
        logger.warning(f"Validation error during ingestion: {str(ve)}")
        raise RAGException(
            error_code="INVALID_REQUEST",
            message=f"Validation error: {str(ve)}",
            suggestion="Please check that you are uploading a valid PDF or TXT document.",
            status_code=400
        )
    except Exception as e:
        logger.error(f"Failed to ingest file {filename}: {str(e)}", exc_info=True)
        raise RAGException(
            error_code="OCR_ERROR",
            message="We were unable to read or parse the uploaded document.",
            suggestion="Verify the document is not corrupt or password-protected and upload it again.",
            status_code=500
        )

@app.post("/api/chat")
@app.post("/chat")
async def chat_interaction(request: ChatRequest):
    """
    Main agentic chat endpoint.
    The LLM autonomously decides which MCP tools to call (vector_search, summarize_text, ocr_extract)
    and when to stop, via a ReAct-style control loop. The backend never decides workflow order.
    """
    question = request.question.strip()
    if not question:
        raise RAGException(
            error_code="INVALID_REQUEST",
            message="Your question cannot be empty.",
            suggestion="Please type a valid question and try again.",
            status_code=400
        )

    logger.info(f"RAG: Received question: '{question}'")
    return StreamingResponse(
        stream_agent_loop(question),
        media_type="text/event-stream"
    )

# Generator for fallback response
async def stream_fallback_response():
    """Streams the exact fallback text required when no context is found."""
    fallback_text = "Answer not available in uploaded documents"
    yield f"data: {json.dumps({'content': fallback_text})}\n\n"
    await asyncio.sleep(0.1)
    yield "data: [DONE]\n\n"

# Generator for summary fallback response when no documents are uploaded
async def stream_no_docs_summary_response():
    """Streams the fallback text when a summary is requested but no documents are found."""
    fallback_text = "No documents uploaded yet. Please upload a document to summarize."
    yield f"data: {json.dumps({'content': fallback_text})}\n\n"
    await asyncio.sleep(0.1)
    yield "data: [DONE]\n\n"

# Helper to chunk text
def split_text_into_chunks(text: str, chunk_size: int = 1500) -> list[str]:
    chunks = []
    words = text.split()
    current_chunk = []
    current_length = 0
    for word in words:
        current_chunk.append(word)
        current_length += len(word) + 1
        if current_length >= chunk_size:
            chunks.append(" ".join(current_chunk))
            current_chunk = []
            current_length = 0
    if current_chunk:
        chunks.append(" ".join(current_chunk))
    return chunks

# Generator for Ollama Summarization Streaming (uses non-streaming Ollama calls internally)
async def stream_summarize_completion(filename: str, full_text: str, user_query: str):
    """
    Summarizes the document in an optimized, chunked map-reduce fashion,
    providing real-time progress feedback to the client in streaming SSE format.
    """
    import httpx
    
    # 1. Chunk the document text (optimized chunk size ~4000 chars)
    chunks = split_text_into_chunks(full_text, chunk_size=4000)
    num_chunks = len(chunks)
    logger.info(f"Summarization: Split '{filename}' into {num_chunks} chunks.")
    
    # Send initial progress title
    _title_payload = json.dumps({"content": "### Document Summarization Progress\n"})
    yield f"data: {_title_payload}\n\n"
    await asyncio.sleep(0.05)
    
    url = "http://localhost:11434/api/generate"
    partial_summaries = []
    
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            # 2. Summarize each chunk separately (non-streaming)
            for idx, chunk in enumerate(chunks):
                progress_msg = f"* \U0001f50d Analyzing section {idx + 1} of {num_chunks}...*\n"
                logger.info(f"Summarizing chunk {idx + 1}/{num_chunks}...")
                _progress_payload = json.dumps({"content": progress_msg})
                yield f"data: {_progress_payload}\n\n"
                await asyncio.sleep(0.05)
                
                system_prompt = (
                    "You are an expert document summarizer.\n"
                    "Your task is to summarize the provided text segment in a brief 1 to 2 sentences.\n\n"
                    "Rules:\n"
                    "1. Base your summary strictly on the provided text. Do not use external facts.\n"
                    "2. Keep the summary professional, direct, and concise."
                )
                prompt = (
                    f"<|system|>\n{system_prompt}\n"
                    f"<|user|>\nText Segment:\n{chunk}\n\n"
                    f"Provide a brief 1 to 2 sentence summary of the segment.\n"
                    f"<|assistant|>\n"
                )
                payload = {
                    "model": LLM_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "num_predict": 150,
                        "temperature": 0.2
                    }
                }
                
                try:
                    response = await client.post(url, json=payload, timeout=180.0)
                    if response.status_code != 200:
                        logger.error(f"Ollama chunk {idx+1} summary failed with status {response.status_code}")
                        continue
                    
                    data = response.json()
                    summary_text = data.get("response", "").strip()
                    if summary_text:
                        partial_summaries.append(summary_text)
                        logger.info(f"Chunk {idx + 1} summarized successfully.")
                except Exception as chunk_err:
                    logger.error(f"Graceful bypass: Chunk {idx+1} failed to summarize: {str(chunk_err)}")
                    continue
            
            # Check if any chunk summary succeeded
            if not partial_summaries:
                raise Exception("Failed to summarize any individual document chunk.")
            
            # 3. Final compression step (non-streaming)
            logger.info(f"Summarization: Merging {len(partial_summaries)} partial summaries...")
            comp_msg = "* \u270d\ufe0f Compiling and generating final summary...*\n\n---\n\n"
            _comp_payload = json.dumps({"content": comp_msg})
            yield f"data: {_comp_payload}\n\n"
            await asyncio.sleep(0.05)
            
            merged_summaries = "\n\n".join(partial_summaries)
            
            comp_system_prompt = (
                "You are an expert document summarizer.\n"
                "Your task is to merge the provided partial summaries into a single, coherent, and well-structured final summary.\n\n"
                "Rules:\n"
                "1. Base your summary strictly on the provided partial summaries. Do not add external facts.\n"
                "2. Adhere to any word limits, formatting, or focus requested: "
                f"'{user_query}' (if not specified, generate a coherent summary under 120 words).\n"
                "3. Keep the summary professional, cohesive, and concise."
            )
            comp_prompt = (
                f"<|system|>\n{comp_system_prompt}\n"
                f"<|user|>\nPartial Summaries:\n{merged_summaries}\n\n"
                f"Generate a coherent final summary.\n"
                f"<|assistant|>\n"
            )
            comp_payload = {
                "model": LLM_MODEL,
                "prompt": comp_prompt,
                "stream": False,
                "options": {
                    "num_predict": 200,
                    "temperature": 0.2
                }
            }
            
            logger.info("Generating final compressed summary...")
            comp_response = await client.post(url, json=comp_payload, timeout=180.0)
            if comp_response.status_code != 200:
                comp_error = await comp_response.aread()
                raise Exception(f"Ollama compression failed with status {comp_response.status_code}: {comp_error.decode()}")
            
            comp_data = comp_response.json()
            final_summary = comp_data.get("response", "").strip()
            
            # 4. Return only the final summary to the API caller in SSE format
            if final_summary:
                _final_payload = json.dumps({"content": final_summary})
                yield f"data: {_final_payload}\n\n"
            else:
                _empty_payload = json.dumps({"content": "Summarization completed but generated an empty final summary."})
                yield f"data: {_empty_payload}\n\n"
                
            yield "data: [DONE]\n\n"
            logger.info(f"Summarization for {filename} completed successfully.")
            
    except Exception as stream_err:
        logger.error(f"Local LLM summarization error: {str(stream_err)}")
        err_str = str(stream_err)
        if "not found" in err_str.lower() or "pull" in err_str.lower():
            err_msg = "The language model is not installed locally."
            suggestion = "Please install the correct Llama model in Ollama."
        elif "connect" in err_str.lower() or "refused" in err_str.lower() or "connection" in err_str.lower():
            err_msg = "Could not connect to the local language model service."
            suggestion = "Please make sure Ollama is open and running in the background."
        else:
            err_msg = "An error occurred during document summarization."
            suggestion = "Please try again in a few seconds."
            
        err_payload = {
            "success": False,
            "error_code": "LLM_ERROR",
            "message": err_msg,
            "suggestion": suggestion
        }
        yield f"data: {json.dumps(err_payload)}\n\n"

# Generator for LLM Streaming
async def stream_ollama_completion(question: str, context_str: str):
    """
    Asynchronously streams the Ollama local chat completion response to the frontend.
    """
    import httpx
    
    system_prompt = (
        "You are a precise document QA assistant.\n"
        "Your task is to answer the user's question strictly using the provided context chunks.\n\n"
        "Rules:\n"
        "1. Answer the question based ONLY on the context blocks provided. Do not use external facts or pre-trained knowledge.\n"
        "2. If the context is empty, or does not contain the information needed to answer the question, "
        "you MUST respond exactly with the phrase: \"Answer not available in uploaded documents\". Do not write anything else.\n"
        "3. Provide source references (e.g. 'Source: specification.pdf') when answering facts.\n"
        "4. Keep your answer factual, direct, and concise."
    )
    
    prompt = (
        f"<|system|>\n{system_prompt}\n"
        f"<|user|>\nRetrieved Context:\n{context_str}\n\nUser Question:\n{question}\n"
        f"<|assistant|>\n"
    )
    
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": LLM_MODEL,
        "prompt": prompt,
        "stream": True
    }
    
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream("POST", url, json=payload, timeout=180.0) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    raise Exception(f"Ollama returned status {response.status_code}: {error_text.decode()}")
                
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        content = data.get("response", "")
                        if content:
                            yield f"data: {json.dumps({'content': content})}\n\n"
                        if data.get("done", False):
                            break
                    except json.JSONDecodeError:
                        continue
                        
            yield "data: [DONE]\n\n"
            logger.info("Ollama local LLM stream response completed successfully.")
            
    except Exception as stream_err:
        logger.error(f"Local LLM streaming error: {str(stream_err)}")
        err_str = str(stream_err)
        if "not found" in err_str.lower() or "pull" in err_str.lower():
            err_msg = "The language model is not installed locally."
            suggestion = "Please install the correct Llama model in Ollama."
        elif "connect" in err_str.lower() or "refused" in err_str.lower() or "connection" in err_str.lower():
            err_msg = "Could not connect to the local language model service."
            suggestion = "Please make sure Ollama is open and running in the background."
        else:
            err_msg = "An error occurred while generating the response."
            suggestion = "Please try asking your question again."
            
        err_payload = {
            "success": False,
            "error_code": "LLM_ERROR",
            "message": err_msg,
            "suggestion": suggestion
        }
        yield f"data: {json.dumps(err_payload)}\n\n"

@app.get("/api/documents")
@app.get("/documents")
async def list_documents():
    """
    Returns the list of indexed documents and their chunk counts.
    """
    try:
        docs = get_indexed_documents()
        return {"documents": docs}
    except Exception as e:
        logger.error(f"Failed to fetch indexed documents: {str(e)}")
        raise RAGException(
            error_code="DB_ERROR",
            message="We were unable to retrieve the list of uploaded documents from the database.",
            suggestion="Please check if Chroma DB is running or re-upload your files.",
            status_code=500
        )

@app.delete("/api/documents")
@app.delete("/documents")
async def delete_all_documents():
    """
    Clears the Chroma database vector index.
    """
    try:
        logger.info("Clearing vector database indices...")
        clear_vector_db()
        logger.info("Database successfully cleared.")
        return {"status": "success", "message": "All documents successfully removed."}
    except Exception as e:
        logger.error(f"Failed to clear database: {str(e)}")
        raise RAGException(
            error_code="DB_ERROR",
            message="We could not clear the vector database.",
            suggestion="Please try restarting the backend server.",
            status_code=500
        )

# Serve compiled Next.js static frontend files if they exist
frontend_out = os.path.join(BASE_DIR, "frontend", "out")
next_dir = os.path.join(frontend_out, "_next")

if os.path.exists(next_dir):
    app.mount("/_next", StaticFiles(directory=next_dir), name="next-static")

# Mount simple static directory if it exists
static_dir = os.path.join(BASE_DIR, "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
async def serve_frontend():
    """
    Serves the compiled Next.js index.html page at root URL.
    """
    html_path = os.path.join(BASE_DIR, "frontend", "out", "index.html")
    if os.path.exists(html_path):
        return FileResponse(html_path)
        
    # Fallback to simple static directory if Next.js export is missing
    old_html = os.path.join(BASE_DIR, "static", "index.html")
    if os.path.exists(old_html):
        return FileResponse(old_html)
        
    return JSONResponse(
        status_code=404,
        content={"error": "Frontend static files are missing. Please run 'npm run build' inside 'frontend/' to compile the Next.js UI."}
    )
