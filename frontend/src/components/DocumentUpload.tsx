"use client";

import React, { useRef, useState } from "react";
import { Upload, FileText, CheckCircle2, Loader2, Trash2 } from "lucide-react";

export const getApiUrl = (path: string): string => {
  if (typeof window !== "undefined") {
    if (window.location.port === "3000") {
      return `http://127.0.0.1:8000${path}`;
    }
  }
  return path;
};

interface DocumentUploadProps {
  onShowToast: (msg: string, isErr?: boolean) => void;
  documents: Record<string, number>;
  onReloadDocs: () => void;
}

export const DocumentUpload: React.FC<DocumentUploadProps> = ({
  onShowToast,
  documents,
  onReloadDocs,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const docNames = Object.keys(documents);

  const handleZoneClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUpload(e.target.files[0]);
    }
  };

  const handleUpload = async (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "pdf" && ext !== "txt") {
      onShowToast("Please upload a PDF or TXT file.", true);
      return;
    }

    setIsUploading(true);
    setUploadSuccess(false);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(getApiUrl("/upload"), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errObj;
        try {
          errObj = await response.json();
        } catch (e) {
          throw new Error("Could not connect to the backend server.");
        }
        throw new Error(errObj.message || "Could not upload the document.");
      }

      setUploadSuccess(true);
      onShowToast("Document uploaded successfully.");
      onReloadDocs();
    } catch (err: any) {
      onShowToast(err.message, true);
    } finally {
      setIsUploading(false);
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Are you sure you want to remove all uploaded documents?")) return;
    
    setIsClearing(true);
    setUploadSuccess(false);
    
    try {
      const response = await fetch(getApiUrl("/documents"), {
        method: "DELETE",
      });
      if (!response.ok) {
        let errObj;
        try {
          errObj = await response.json();
        } catch (e) {
          throw new Error("Could not clear the documents.");
        }
        throw new Error(errObj.message || "Could not clear the documents.");
      }
      
      onShowToast("All documents removed successfully.");
      onReloadDocs();
    } catch (err: any) {
      onShowToast(err.message, true);
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <section className="w-full lg:w-96 shrink-0 flex flex-col gap-6">
      {/* Upload Box */}
      <div className="bg-white border border-stone-200/80 rounded-2xl p-6 shadow-sm flex flex-col gap-4">
        <div>
          <h2 className="font-outfit font-semibold text-lg text-stone-855">
            Document Upload
          </h2>
          <p className="text-xs text-stone-500 mt-0.5">
            Add a file to start asking questions about its contents.
          </p>
        </div>

        <div
          onClick={handleZoneClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-300 group flex flex-col items-center justify-center gap-4 select-none ${
            isDragOver
              ? "border-violet-500 bg-violet-50/40 shadow-sm"
              : "border-stone-200 hover:border-violet-400 bg-stone-50/50 hover:bg-stone-50"
          }`}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            accept=".pdf,.txt"
          />

          <div className="h-12 w-12 rounded-full bg-white border border-stone-200 flex items-center justify-center text-stone-400 group-hover:text-violet-500 group-hover:border-violet-200 transition-all duration-300 shadow-sm">
            {isUploading ? (
              <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
            ) : (
              <Upload className="h-6 w-6" />
            )}
          </div>

          <div>
            <p className="text-sm font-medium text-stone-700 group-hover:text-violet-750 transition-colors duration-200">
              Upload your document
            </p>
            <p className="text-xs text-stone-500 mt-1">
              PDF or text files supported
            </p>
          </div>
        </div>

        {/* Upload Success Alert */}
        {uploadSuccess && (
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3.5 flex items-start gap-2.5 animate-fade-in">
            <CheckCircle2 className="h-5 w-5 text-emerald-650 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-emerald-800">
                Document ready
              </p>
              <p className="text-[11px] text-emerald-700 mt-0.5">
                You can now ask questions.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Files List */}
      <div className="bg-white border border-stone-200/80 rounded-2xl p-6 shadow-sm flex flex-col grow min-h-[220px] lg:min-h-0">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div>
            <h3 className="font-outfit font-semibold text-md text-stone-850">
              Your Files
            </h3>
            <p className="text-[11px] text-stone-500 mt-0.5">
              Available as conversation context
            </p>
          </div>
          <span className="px-2.5 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-xs text-stone-600 font-medium select-none">
            {docNames.length} file{docNames.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="grow overflow-y-auto pr-1 space-y-2.5 scrollbar-custom max-h-[250px] lg:max-h-none">
          {docNames.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-8 px-4 gap-2 select-none">
              <FileText className="h-10 w-10 text-stone-300" />
              <div>
                <p className="text-xs font-semibold text-stone-655">No documents uploaded yet</p>
                <p className="text-[11px] text-stone-400 mt-1 max-w-[200px]">
                  Use the upload area above to send your first document.
                </p>
              </div>
            </div>
          ) : (
            docNames.map((name) => (
              <div
                key={name}
                className="p-3.5 rounded-xl bg-stone-50 border border-stone-200 hover:border-stone-300 transition duration-200 flex items-center justify-between gap-3 animate-fade-in"
              >
                <div className="flex items-center gap-3 truncate">
                  <div className="h-8 w-8 rounded-lg bg-white border border-stone-200 flex items-center justify-center text-stone-500 shrink-0">
                    <FileText className="h-4.5 w-4.5" />
                  </div>
                  <div className="truncate">
                    <p className="text-xs font-semibold text-stone-800 truncate" title={name}>
                      {name}
                    </p>
                    <p className="text-[10px] text-stone-400 mt-0.5">
                      Ready to ask
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {docNames.length > 0 && (
          <div className="mt-4 pt-4 border-t border-stone-100 shrink-0">
            <button
              onClick={handleClearAll}
              disabled={isClearing}
              className="w-full bg-white hover:bg-rose-50 border border-stone-200 hover:border-rose-200 disabled:border-stone-100 text-stone-600 hover:text-rose-600 disabled:text-stone-300 rounded-xl py-2.5 text-xs font-medium transition duration-200 flex items-center justify-center gap-2 active:scale-[0.98] cursor-pointer disabled:cursor-not-allowed select-none shadow-sm hover:shadow-sm"
            >
              <Trash2 className="h-4 w-4" /> Remove all documents
            </button>
          </div>
        )}
      </div>
    </section>
  );
};
