"use client";

import React, { useState, useEffect, useCallback } from "react";
import { CheckCircle2, AlertCircle, FileText } from "lucide-react";
import { DocumentUpload, getApiUrl } from "../components/DocumentUpload";
import { ChatPanel } from "../components/ChatPanel";

interface ToastState {
  message: string;
  isError: boolean;
  visible: boolean;
}

export default function Home() {
  const [documents, setDocuments] = useState<Record<string, number>>({});
  
  const [toast, setToast] = useState<ToastState>({
    message: "",
    isError: false,
    visible: false,
  });

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await fetch(getApiUrl("/documents"));
      if (response.ok) {
        const data = await response.json();
        setDocuments(data.documents || {});
      }
    } catch (err) {
      console.error("Failed to load documents list:", err);
    }
  }, []);

  const showToast = (message: string, isError = false) => {
    setToast({ message, isError, visible: true });
    setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, 4000);
  };

  const hasDocuments = Object.keys(documents).length > 0;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-stone-50 text-stone-900 relative">
      {/* Friendly subtle background decorations */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-violet-200/20 rounded-full blur-[120px] pointer-events-none z-0"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-indigo-200/20 rounded-full blur-[150px] pointer-events-none z-0"></div>

      {/* Simple, Google-Docs-like Header */}
      <header className="relative shrink-0 z-20 border-b border-stone-200/60 bg-white/80 backdrop-blur-md px-6 py-4 flex items-center justify-between select-none">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-violet-600 flex items-center justify-center shadow-md shadow-violet-600/10">
            <FileText className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-md font-bold tracking-tight text-stone-850 font-outfit">
              AI Document Assistant
            </h1>
            <p className="text-[11px] text-stone-500 font-medium">Ask questions in plain English</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {hasDocuments ? (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-150 text-xs text-emerald-700 font-medium animate-fade-in">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              <span>Document is ready</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-stone-100 border border-stone-200 text-xs text-stone-500 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-stone-400"></span>
              <span>No document uploaded</span>
            </div>
          )}
        </div>
      </header>

      {/* Workspace Dashboard */}
      <main className="grow flex flex-col lg:flex-row overflow-hidden p-6 gap-6 relative z-10">
        
        {/* Upload panel */}
        <DocumentUpload
          onShowToast={showToast}
          documents={documents}
          onReloadDocs={loadDocuments}
        />

        {/* Chat Studio */}
        <div className="grow flex flex-col relative h-[50%] lg:h-full">
          <ChatPanel
            onShowToast={showToast}
            hasDocuments={hasDocuments}
          />
        </div>
      </main>

      {/* Toast banners */}
      {toast.visible && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl border flex items-center gap-2.5 text-xs shadow-xl animate-fade-in transition-all duration-300 ${
            toast.isError
              ? "bg-rose-50 border-rose-250 text-rose-800"
              : "bg-stone-900 border-stone-800 text-stone-100 shadow-stone-900/10"
          }`}
        >
          {toast.isError ? (
            <AlertCircle className="h-4.5 w-4.5 text-rose-500 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4.5 w-4.5 text-emerald-555 shrink-0" />
          )}
          <span className="font-semibold">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
