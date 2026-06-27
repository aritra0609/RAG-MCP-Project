"use client";

import React, { useState, useEffect, useRef } from "react";
import { Send, Sparkles, User, AlertCircle, Loader } from "lucide-react";
import { getApiUrl } from "./DocumentUpload";

interface Message {
  id: string;
  role: "user" | "bot" | "error";
  text: string;
}

interface ChatPanelProps {
  onShowToast: (msg: string, isErr?: boolean) => void;
  hasDocuments: boolean;
}

const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

const formatMarkdown = (text: string): string => {
  if (!text) return "";
  let html = escapeHtml(text);

  // Code Blocks (triple backticks)
  html = html.replace(/```(?:[a-zA-Z0-9]+)?([\s\S]*?)```/g, (match, p1) => {
    return `<pre class="my-3 p-4 bg-stone-100 border border-stone-200 rounded-xl overflow-x-auto"><code class="font-mono text-stone-800 text-[11px] block whitespace-pre">${p1.trim()}</code></pre>`;
  });

  // Inline Code (single backticks)
  html = html.replace(/`([^`\n]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-stone-100 text-violet-650 font-mono text-[11px] border border-stone-200">$1</code>');

  // Bold (**text**)
  html = html.replace(/\*\*([\s\S]*?)\*\*/g, '<strong class="font-bold text-stone-900">$1</strong>');

  // Italic (*text*)
  html = html.replace(/\*([\s\S]*?)\*/g, '<em class="italic text-stone-500">$1</em>');

  // Paragraph spacing
  html = html.split("\n\n").map(p => {
    const trimmed = p.trim();
    if (trimmed.startsWith("&lt;pre") || trimmed.startsWith("&lt;ul") || trimmed.startsWith("•")) {
      return trimmed;
    }
    return `<p class="mb-2.5 last:mb-0">${trimmed}</p>`;
  }).join("");

  // Friendly references formatting
  html = html.replace(/\[Source:\s*([^\]]+)\]/g, '<span class="inline-flex items-center px-2 py-0.5 mt-1 rounded-full bg-violet-50 text-[10px] text-violet-755 font-medium border border-violet-100">From $1</span>');

  return html;
};

export const ChatPanel: React.FC<ChatPanelProps> = ({ onShowToast, hasDocuments }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const scrollChat = () => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollChat();
  }, [messages, streamingText, isThinking]);

  const handleSubmit = async (e?: React.FormEvent, forcedQuery?: string) => {
    if (e) e.preventDefault();
    const query = (forcedQuery || inputValue).trim();
    if (!query || isStreaming) return;

    if (!forcedQuery) {
      setInputValue("");
    }
    setIsStreaming(true);
    setStreamingText("");
    setIsThinking(true);
    
    const userMsgId = `user-${Date.now()}`;
    setMessages((prev) => [...prev, { id: userMsgId, role: "user", text: query }]);

    try {
      const response = await fetch(getApiUrl("/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query }),
      });

      if (!response.ok) {
        let errData;
        try {
          errData = await response.json();
        } catch (e) {
          throw {
            error_code: "NETWORK_ERROR",
            message: "We couldn't connect to the backend server.",
            suggestion: "Make sure the backend service is running locally on port 8000."
          };
        }
        throw errData;
      }

      setIsThinking(false);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder("utf-8");
      if (!reader) throw new Error("Could not read response stream.");

      let finished = false;
      let buffer = "";
      let accumulatedText = "";

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawFrame = buffer.substring(0, boundary);
          buffer = buffer.substring(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          const lines = rawFrame.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const dataStr = line.slice(6).trim();
              if (dataStr === "[DONE]") {
                finished = true;
                break;
              }

              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.success === false) {
                  throw parsed;
                }
                // Handle agent status updates
                if (typeof parsed.agent_status === "string") {
                  if (parsed.agent_status === "") {
                    setAgentStatus("");
                    setIsThinking(false);
                  } else {
                    setAgentStatus(parsed.agent_status);
                  }
                }
                if (parsed.content) {
                  accumulatedText += parsed.content;
                  setStreamingText(accumulatedText);
                }
                if (parsed.error) {
                  throw new Error(parsed.error);
                }
              } catch (e) {
                if (e && (e as any).error_code) {
                  throw e;
                }
                // Ignore chunk boundary parsing warnings
              }
            }
          }
        }
      }

      const aiMsgId = `bot-${Date.now()}`;
      setMessages((prev) => [...prev, { id: aiMsgId, role: "bot", text: accumulatedText }]);
      setStreamingText("");

    } catch (err: any) {
      setIsThinking(false);
      setAgentStatus("");
      const errMsgId = `err-${Date.now()}`;
      
      const structuredError = {
        error_code: err.error_code || "UNKNOWN_ERROR",
        message: err.message || err.detail || "An unexpected error occurred.",
        suggestion: err.suggestion || "Please try again later.",
        retryQuery: query
      };

      setMessages((prev) => [
        ...prev,
        { id: errMsgId, role: "error", text: JSON.stringify(structuredError) },
      ]);
      onShowToast(structuredError.message, true);
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
      setAgentStatus("");
    }
  };

  return (
    <section className="grow flex flex-col bg-white border border-stone-200/80 rounded-2xl shadow-sm overflow-hidden relative">
      <div className="shrink-0 px-6 py-4 border-b border-stone-100 bg-stone-50/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-violet-500 animate-pulse"></div>
          <div>
            <h2 className="text-sm font-semibold text-stone-800">Conversation</h2>
            <p className="text-[11px] text-stone-500">Ask questions grounded in your document</p>
          </div>
        </div>
      </div>

      {/* Messages view */}
      <div className="grow overflow-y-auto p-6 space-y-5 scrollbar-custom">
        {messages.length === 0 && !isThinking && !streamingText && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 gap-4 select-none">
            <div className="h-12 w-12 rounded-2xl bg-violet-50 flex items-center justify-center text-violet-500">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="max-w-md">
              <h3 className="font-outfit font-semibold text-stone-800">Ask anything about your document</h3>
              <p className="text-xs text-stone-500 mt-1.5 leading-relaxed">
                {hasDocuments
                  ? "Type your question below, and I'll find the answer directly from your uploaded document."
                  : "Please upload a document on the left first to begin the conversation."}
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          const isError = msg.role === "error";

          return (
            <div
              key={msg.id}
              className={`flex gap-4 max-w-[85%] animate-fade-in ${
                isUser ? "ml-auto flex-row-reverse" : ""
              }`}
            >
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 shadow-sm text-xs font-semibold ${
                  isUser
                    ? "bg-violet-100 text-violet-700 border border-violet-200"
                    : isError
                      ? "bg-rose-100 text-rose-700 border border-rose-200"
                      : "bg-stone-100 text-stone-650 border border-stone-200"
                }`}
              >
                {isUser ? <User className="h-4.5 w-4.5" /> : isError ? <AlertCircle className="h-4.5 w-4.5" /> : "AI"}
              </div>
              
              {isError ? (
                (() => {
                  let errorObj = { error_code: "UNKNOWN_ERROR", message: msg.text, suggestion: "Please try again.", retryQuery: "" };
                  try {
                    errorObj = JSON.parse(msg.text);
                  } catch (e) {}

                  return (
                    <div className="bg-rose-50 border border-rose-100 text-rose-900 rounded-2xl rounded-tl-none p-4 flex flex-col gap-2 shadow-sm max-w-full">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-bold font-mono tracking-wide uppercase bg-rose-100 text-rose-750 px-2 py-0.5 rounded border border-rose-200">
                          {errorObj.error_code}
                        </span>
                        <span className="text-xs font-semibold text-rose-800">Operation Failed</span>
                      </div>
                      <p className="text-xs text-rose-700 font-medium leading-relaxed font-outfit">
                        {errorObj.message}
                      </p>
                      {errorObj.suggestion && (
                        <div className="text-[11px] text-rose-600/90 leading-relaxed border-t border-rose-200/50 pt-2 flex items-start gap-1 font-outfit">
                          <span>💡</span>
                          <span><strong>Suggestion:</strong> {errorObj.suggestion}</span>
                        </div>
                      )}
                      {errorObj.retryQuery && (
                        <button
                          type="button"
                          onClick={() => handleSubmit(undefined, errorObj.retryQuery)}
                          className="self-start mt-1 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-semibold transition active:scale-[0.98] shadow-sm flex items-center gap-1 cursor-pointer"
                        >
                          🔄 Retry Query
                        </button>
                      )}
                    </div>
                  );
                })()
              ) : (
                <div
                  className={`p-4 rounded-2xl text-xs leading-relaxed ${
                    isUser
                      ? "bg-violet-600 text-white rounded-tr-none shadow-sm shadow-violet-500/10"
                      : "bg-stone-50 border border-stone-200 text-stone-700 rounded-tl-none"
                  }`}
                  dangerouslySetInnerHTML={{
                    __html: isUser ? escapeHtml(msg.text) : formatMarkdown(msg.text),
                  }}
                ></div>
              )}
            </div>
          );
        })}

        {isThinking && (
          <div className="flex gap-4 max-w-[85%] animate-fade-in select-none">
            <div className="h-8 w-8 rounded-full bg-stone-100 text-stone-650 border border-stone-200 flex items-center justify-center shrink-0 shadow-sm text-xs font-semibold">
              AI
            </div>
            <div className="bg-stone-50 border border-stone-200 rounded-2xl rounded-tl-none p-4 text-xs flex flex-col gap-2">
              {agentStatus ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-700 bg-violet-50 border border-violet-100 px-2.5 py-1 rounded-full animate-pulse">
                  {agentStatus}
                </span>
              ) : null}
              <div className="flex items-center gap-2">
                <span className="text-stone-500 font-medium">AI is thinking</span>
                <span className="flex gap-1 items-center mt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: "0s" }}></span>
                  <span className="h-1.5 w-1.5 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: "0.15s" }}></span>
                  <span className="h-1.5 w-1.5 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: "0.3s" }}></span>
                </span>
              </div>
            </div>
          </div>
        )}

        {streamingText && (
          <div className="flex gap-4 max-w-[85%] animate-fade-in">
            <div className="h-8 w-8 rounded-full bg-stone-100 text-stone-650 border border-stone-200 flex items-center justify-center shrink-0 shadow-sm text-xs font-semibold">
              AI
            </div>
            <div
              className="bg-stone-50 border border-stone-200 rounded-2xl rounded-tl-none p-4 text-xs leading-relaxed text-stone-750 grow typing-cursor"
              dangerouslySetInnerHTML={{ __html: formatMarkdown(streamingText) }}
            ></div>
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* Input form */}
      <div className="shrink-0 p-5 border-t border-stone-100 bg-stone-50/50">
        <form onSubmit={handleSubmit} className="flex gap-3 relative">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isStreaming || !hasDocuments}
            placeholder={
              hasDocuments
                ? "Ask anything about your document..."
                : "Please upload a document to start..."
            }
            className="grow bg-white border border-stone-250 focus:border-violet-400 rounded-xl py-3 px-4 pr-12 text-xs focus:ring-1 focus:ring-violet-200 text-stone-850 placeholder-stone-400 transition outline-none shadow-sm"
          />
          <button
            type="submit"
            disabled={isStreaming || !inputValue.trim() || !hasDocuments}
            className="bg-violet-600 hover:bg-violet-550 disabled:bg-stone-100 disabled:text-stone-300 text-white rounded-xl px-5 transition duration-200 flex items-center justify-center cursor-pointer disabled:cursor-not-allowed shadow-md shadow-violet-550/10 active:scale-[0.97]"
          >
            <Send className="h-4.5 w-4.5" />
          </button>
        </form>
      </div>
    </section>
  );
};
