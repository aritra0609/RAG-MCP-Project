// Aether RAG Frontend JS Engine

document.addEventListener("DOMContentLoaded", () => {
    // DOM Elements
    const apiKeyInput = document.getElementById("api-key-input");
    const saveKeyBtn = document.getElementById("save-key-btn");
    const toggleSettingsBtn = document.getElementById("toggle-settings-btn");
    const closeSettingsBtn = document.getElementById("close-settings-btn");
    const settingsPanel = document.getElementById("settings-panel");
    const keyWarningDot = document.getElementById("key-warning-dot");
    const keyStatusText = document.getElementById("key-status-text");
    const keyIndicatorLight = document.getElementById("key-indicator-light");

    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("file-input");
    const uploadProgressContainer = document.getElementById("upload-progress-container");
    const uploadFilename = document.getElementById("upload-filename");
    const uploadPercentage = document.getElementById("upload-percentage");
    const uploadProgressBar = document.getElementById("upload-progress-bar");
    const uploadStatusSubtext = document.getElementById("upload-status-subtext");

    const documentsList = document.getElementById("documents-list");
    const noDocsPlaceholder = document.getElementById("no-docs-placeholder");
    const docCountBadge = document.getElementById("doc-count-badge");
    const clearIndexBtn = document.getElementById("clear-index-btn");

    const chatMessages = document.getElementById("chat-messages");
    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    const sendBtn = document.getElementById("send-btn");
    const pipelineStatus = document.getElementById("pipeline-status");
    const statusMessage = document.getElementById("status-message");
    const statusIconBox = document.getElementById("status-icon-box");

    // Initialize state
    let apiKey = sessionStorage.getItem("openai_api_key") || "";
    
    // Initialize icons
    lucide.createIcons();

    // 1. API Key Setup & Validation
    if (apiKey) {
        apiKeyInput.value = apiKey;
        updateKeyUI(true, "Key loaded from Session");
    } else {
        updateKeyUI(false, "No API Key configured. Input key below.");
    }

    // Toggle Settings panel
    toggleSettingsBtn.addEventListener("click", () => {
        settingsPanel.classList.toggle("hidden");
    });

    closeSettingsBtn.addEventListener("click", () => {
        settingsPanel.classList.add("hidden");
    });

    // Save key
    saveKeyBtn.addEventListener("click", () => {
        const key = apiKeyInput.value.trim();
        if (key) {
            apiKey = key;
            sessionStorage.setItem("openai_api_key", key);
            updateKeyUI(true, "Key saved to Session");
            settingsPanel.classList.add("hidden");
            enableChatInput();
        } else {
            apiKey = "";
            sessionStorage.removeItem("openai_api_key");
            updateKeyUI(false, "Credentials cleared");
        }
    });

    function updateKeyUI(isSet, message) {
        if (isSet) {
            keyWarningDot.classList.add("hidden");
            keyIndicatorLight.className = "h-1.5 w-1.5 rounded-full bg-emerald-500";
            keyStatusText.textContent = message;
            keyStatusText.className = "text-emerald-400 text-xs";
            enableChatInput();
        } else {
            keyWarningDot.classList.remove("hidden");
            keyIndicatorLight.className = "h-1.5 w-1.5 rounded-full bg-amber-500";
            keyStatusText.textContent = message;
            keyStatusText.className = "text-amber-400 text-xs";
            disableChatInput();
        }
    }

    function enableChatInput() {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.placeholder = "Ask a question about your indexed documents...";
    }

    function disableChatInput() {
        chatInput.disabled = true;
        sendBtn.disabled = true;
        chatInput.placeholder = "Please save your OpenAI API Key first (click the Key icon top-right)...";
    }

    // 2. Load documents list from Chroma
    async function loadDocuments() {
        try {
            const response = await fetch("/api/documents");
            if (!response.ok) throw new Error("Failed to load documents list");
            
            const data = await response.json();
            const docs = data.documents || {};
            const docNames = Object.keys(docs);
            
            // Update badge
            docCountBadge.textContent = `${docNames.length} File${docNames.length === 1 ? "" : "s"}`;
            
            if (docNames.length === 0) {
                noDocsPlaceholder.classList.remove("hidden");
                // Clear existing cards
                const cards = documentsList.querySelectorAll(".doc-card");
                cards.forEach(card => card.remove());
                return;
            }
            
            noDocsPlaceholder.classList.add("hidden");
            
            // Clear and render list
            const cards = documentsList.querySelectorAll(".doc-card");
            cards.forEach(card => card.remove());

            docNames.forEach(name => {
                const chunks = docs[name];
                const card = document.createElement("div");
                card.className = "doc-card p-3 rounded-xl bg-zinc-950/65 border border-zinc-850 hover:border-zinc-800 transition flex items-center justify-between gap-3 animate-fade-in";
                card.innerHTML = `
                    <div class="flex items-center gap-2.5 truncate">
                        <div class="h-7 w-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 shrink-0">
                            <i data-lucide="${name.toLowerCase().endsWith(".pdf") ? "file-text" : "file-code"}" class="h-4 w-4"></i>
                        </div>
                        <div class="truncate">
                            <p class="text-xs font-medium text-zinc-200 truncate" title="${name}">${name}</p>
                            <p class="text-[9px] text-zinc-500 font-semibold uppercase mt-0.5">${chunks} Chunks indexed</p>
                        </div>
                    </div>
                `;
                documentsList.appendChild(card);
            });
            lucide.createIcons();
            
        } catch (err) {
            console.error(err);
        }
    }

    // 3. Clear database index
    clearIndexBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to clear the entire vector database? This cannot be undone.")) return;
        
        setPipelineStatus("Clearing DB...", "trash-2", "text-red-400");
        try {
            const response = await fetch("/api/documents", { method: "DELETE" });
            if (!response.ok) throw new Error("Failed to clear database");
            
            showToast("Vector database cleared successfully.");
            await loadDocuments();
        } catch (err) {
            showToast(`Clear index error: ${err.message}`, true);
        } finally {
            resetPipelineStatus();
        }
    });

    // 4. Ingestion & Drag/Drop Upload
    dropzone.addEventListener("click", () => fileInput.click());

    // Highlight dropzone on dragover
    ["dragenter", "dragover"].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropzone.classList.add("border-violet-500/60", "bg-violet-950/5");
        }, false);
    });

    ["dragleave", "drop"].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropzone.classList.remove("border-violet-500/60", "bg-violet-950/5");
        }, false);
    });

    // Handle dropped files
    dropzone.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFileUpload(files[0]);
        }
    });

    // Handle selected files
    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
        }
    });

    function handleFileUpload(file) {
        const ext = file.name.split(".").pop().toLowerCase();
        if (ext !== "pdf" && ext !== "txt") {
            showToast("Unsupported file. Please upload PDF or TXT only.", true);
            return;
        }

        // Setup progress state
        uploadFilename.textContent = file.name;
        uploadPercentage.textContent = "0%";
        uploadProgressBar.style.width = "0%";
        uploadStatusSubtext.textContent = "Reading file into buffers...";
        uploadProgressContainer.classList.remove("hidden");
        setPipelineStatus("Ingesting Document...", "loader", "text-violet-400 animate-spin");

        // Use XMLHttpRequest to track upload progress
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/upload");

        // Event listener for progress
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                // Since ingestion consists of upload + embedding generation,
                // cap the direct upload progress at 85% and let it show 95% during API generation.
                const visualPercent = Math.min(Math.round(percent * 0.85), 85);
                uploadPercentage.textContent = `${visualPercent}%`;
                uploadProgressBar.style.width = `${visualPercent}%`;
                if (visualPercent > 50) {
                    uploadStatusSubtext.textContent = "Generating semantic embeddings via OpenAI...";
                }
            }
        };

        xhr.onload = () => {
            if (xhr.status === 200) {
                const response = JSON.parse(xhr.responseText);
                uploadPercentage.textContent = "100%";
                uploadProgressBar.style.width = "100%";
                uploadStatusSubtext.textContent = `Indexed successfully! Created ${response.chunks} overlapping chunks.`;
                uploadProgressBar.classList.replace("bg-gradient-to-r", "bg-emerald-500");
                
                showToast(`Document indexed successfully.`);
                loadDocuments();
                
                setTimeout(() => {
                    uploadProgressContainer.classList.add("hidden");
                    uploadProgressBar.classList.replace("bg-emerald-500", "bg-gradient-to-r");
                }, 3000);
            } else {
                let errorMsg = "Ingestion failed.";
                try {
                    const errorResponse = JSON.parse(xhr.responseText);
                    errorMsg = errorResponse.detail || errorMsg;
                } catch(e) {}
                
                uploadStatusSubtext.textContent = `Error: ${errorMsg}`;
                uploadProgressBar.className = "h-full bg-rose-500 rounded-full transition-all duration-300";
                showToast(errorMsg, true);
                
                setTimeout(() => {
                    uploadProgressContainer.classList.add("hidden");
                }, 4000);
            }
            resetPipelineStatus();
        };

        xhr.onerror = () => {
            uploadStatusSubtext.textContent = "Connection interrupted.";
            showToast("Network upload error.", true);
            resetPipelineStatus();
        };

        // Form data construction
        const formData = new FormData();
        formData.append("file", file);
        if (apiKey) {
            formData.append("api_key", apiKey);
        }

        xhr.send(formData);
    }

    // 5. Chat Interaction & SSE Stream Parsing
    chatForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const question = chatInput.value.trim();
        if (!question) return;

        // Reset input fields
        chatInput.value = "";
        chatInput.disabled = true;
        sendBtn.disabled = true;

        // Render user message bubble
        appendMessage("user", question);
        scrollChat();

        // Create temporary AI bubble with typing indicator
        const aiMessageId = `ai-msg-${Date.now()}`;
        appendLoadingBubble(aiMessageId);
        scrollChat();

        // Set status indicators
        setPipelineStatus("MCP Searching...", "search", "text-cyan-400");

        try {
            // Initiate post request with stream reader
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question, api_key: apiKey })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || "Server failed to initiate chat.");
            }

            // Remove loading indicator and ready response container
            removeLoadingBubble(aiMessageId);
            const contentContainer = appendEmptyAIBubble(aiMessageId);
            setPipelineStatus("GPT Generating...", "brain-circuit", "text-violet-400 animate-pulse");

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let finished = false;
            let buffer = "";
            let fullText = "";

            while (!finished) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                
                // Parse standard SSE frames: entries split by \n\n
                let boundary = buffer.indexOf("\n\n");
                while (boundary !== -1) {
                    const rawFrame = buffer.substring(0, boundary);
                    buffer = buffer.substring(boundary + 2);
                    boundary = buffer.indexOf("\n\n");

                    // Process frame line
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
                                if (parsed.content) {
                                    fullText += parsed.content;
                                    contentContainer.innerHTML = formatMarkdown(fullText);
                                    scrollChat();
                                }
                                if (parsed.error) {
                                    throw new Error(parsed.error);
                                }
                            } catch (parseErr) {
                                // Ignore json parsing errors from fragmented chunks
                            }
                        }
                    }
                }
            }

            // Add animation classes after printing ends
            contentContainer.classList.remove("typing-cursor");

        } catch (err) {
            removeLoadingBubble(aiMessageId);
            appendMessage("system-error", `Pipeline failure: ${err.message}`);
            showToast(`Execution error: ${err.message}`, true);
        } finally {
            enableChatInput();
            resetPipelineStatus();
            scrollChat();
        }
    });

    // Helper functions for chat message bubbles
    function appendMessage(role, text) {
        const messageDiv = document.createElement("div");
        messageDiv.className = `flex gap-4 max-w-[85%] animate-fade-in ${role === "user" ? "ml-auto flex-row-reverse" : ""}`;
        
        const isUser = role === "user";
        const bubbleBg = isUser 
            ? "bg-violet-600/25 border border-violet-500/20 text-violet-100 rounded-tr-none" 
            : role === "system-error"
                ? "bg-rose-950/20 border border-rose-900/30 text-rose-300 rounded-tl-none font-medium"
                : "bg-zinc-900/60 border border-zinc-800/50 text-zinc-300 rounded-tl-none";

        const icon = isUser ? "user" : role === "system-error" ? "alert-triangle" : "bot";
        const iconBg = isUser ? "bg-zinc-850 border border-zinc-700" : "bg-gradient-to-tr from-violet-600 to-indigo-500 text-white";

        messageDiv.innerHTML = `
            <div class="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 shadow-sm shrink-0 select-none ${iconBg}">
                <i data-lucide="${icon}" class="h-4 w-4"></i>
            </div>
            <div class="p-4 rounded-2xl text-xs leading-relaxed ${bubbleBg}">
                ${role === "user" ? escapeHtml(text) : formatMarkdown(text)}
            </div>
        `;
        chatMessages.appendChild(messageDiv);
        lucide.createIcons();
    }

    function appendLoadingBubble(id) {
        const messageDiv = document.createElement("div");
        messageDiv.id = id;
        messageDiv.className = "flex gap-4 max-w-[85%] animate-fade-in";
        messageDiv.innerHTML = `
            <div class="h-8 w-8 rounded-lg bg-gradient-to-tr from-violet-600 to-indigo-500 text-white flex items-center justify-center shrink-0 shadow-sm select-none">
                <i data-lucide="bot" class="h-4 w-4"></i>
            </div>
            <div class="bg-zinc-900/60 border border-zinc-800/50 rounded-2xl rounded-tl-none p-4 text-xs shrink-0 flex items-center gap-2">
                <span class="text-zinc-500 font-medium tracking-wide">Retrieving chunks through MCP...</span>
                <span class="flex gap-1">
                    <span class="h-1.5 w-1.5 rounded-full bg-zinc-650 animate-bounce" style="animation-delay: 0s;"></span>
                    <span class="h-1.5 w-1.5 rounded-full bg-zinc-650 animate-bounce" style="animation-delay: 0.15s;"></span>
                    <span class="h-1.5 w-1.5 rounded-full bg-zinc-650 animate-bounce" style="animation-delay: 0.3s;"></span>
                </span>
            </div>
        `;
        chatMessages.appendChild(messageDiv);
        lucide.createIcons();
    }

    function removeLoadingBubble(id) {
        const bubble = document.getElementById(id);
        if (bubble) bubble.remove();
    }

    function appendEmptyAIBubble(id) {
        const messageDiv = document.createElement("div");
        messageDiv.className = "flex gap-4 max-w-[85%] animate-fade-in";
        messageDiv.innerHTML = `
            <div class="h-8 w-8 rounded-lg bg-gradient-to-tr from-violet-600 to-indigo-500 text-white flex items-center justify-center shrink-0 shadow-sm select-none animate-pulse">
                <i data-lucide="bot" class="h-4 w-4"></i>
            </div>
            <div class="bg-zinc-900/60 border border-zinc-800/50 rounded-2xl rounded-tl-none p-4 text-xs leading-relaxed text-zinc-300 grow typing-cursor" id="${id}-text">
                
            </div>
        `;
        chatMessages.appendChild(messageDiv);
        lucide.createIcons();
        return document.getElementById(`${id}-text`);
    }

    function scrollChat() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    // Markdown Parser
    function formatMarkdown(text) {
        if (!text) return "";
        let html = text;

        // Escape HTML tags to prevent custom injected tags (except our own parsed output)
        html = escapeHtml(html);

        // Preformatted Code Blocks (triple backticks)
        html = html.replace(/```(?:[a-zA-Z0-9]+)?([\s\S]*?)```/g, (match, p1) => {
            return `<pre class="my-2 p-3 bg-zinc-950/70 border border-zinc-850 rounded-xl overflow-x-auto"><code class="font-mono text-zinc-300 text-[11px] block whitespace-pre">${p1.trim()}</code></pre>`;
        });

        // Inline Code (single backticks)
        html = html.replace(/`([^`\n]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-zinc-950 text-violet-300 font-mono text-[11px] border border-zinc-850">$1</code>');

        // Bold (**text**)
        html = html.replace(/\*\*([\s\S]*?)\*\*/g, '<strong class="font-bold text-zinc-100">$1</strong>');

        // Italic (*text*)
        html = html.replace(/\*([\s\S]*?)\*/g, '<em class="italic text-zinc-400">$1</em>');

        // Paragraph line spacing
        html = html.split("\n\n").map(p => {
            const trimmed = p.trim();
            if (trimmed.startsWith("&lt;pre") || trimmed.startsWith("&lt;ul") || trimmed.startsWith("•")) {
                return trimmed; // Don't wrap formatted structures
            }
            return `<p class="mb-2 last:mb-0">${trimmed}</p>`;
        }).join("");

        // Handle source citation highlights (e.g. "[Source: document.pdf]")
        html = html.replace(/\[(Source: [^\]]+)\]/g, '<span class="inline-flex items-center px-1.5 py-0.5 mt-1 rounded bg-zinc-950 text-[10px] text-cyan-400 font-semibold border border-zinc-850">$1</span>');

        return html;
    }

    // Pipeline Status tracker helper
    function setPipelineStatus(message, icon, animateClass = "") {
        statusMessage.textContent = message;
        statusIconBox.innerHTML = `<i data-lucide="${icon}" class="h-3 w-3 ${animateClass}"></i>`;
        statusIconBox.className = `h-4.5 w-4.5 rounded-full bg-zinc-950 border border-zinc-850 flex items-center justify-center ${animateClass}`;
        lucide.createIcons();
    }

    function resetPipelineStatus() {
        statusMessage.textContent = "Idle";
        statusIconBox.innerHTML = '<i data-lucide="message-square" class="h-3 w-3"></i>';
        statusIconBox.className = "h-4.5 w-4.5 rounded-full bg-zinc-950 border border-zinc-850 flex items-center justify-center text-zinc-600";
        lucide.createIcons();
    }

    // Dynamic Notification Banner
    function showToast(message, isError = false) {
        const toast = document.createElement("div");
        toast.className = `fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl border flex items-center gap-2.5 text-xs shadow-2xl animate-fade-in ${
            isError 
                ? "bg-rose-950/90 border-rose-900/50 text-rose-200" 
                : "bg-zinc-900/90 border-zinc-800/80 text-zinc-200"
        }`;
        toast.innerHTML = `
            <i data-lucide="${isError ? "alert-circle" : "check-circle-2"}" class="h-4.5 w-4.5 shrink-0 ${isError ? "text-rose-400" : "text-emerald-400"}"></i>
            <span class="font-medium">${message}</span>
        `;
        document.body.appendChild(toast);
        lucide.createIcons();

        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(8px)";
            toast.style.transition = "all 0.3s ease";
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // Load list on start
    loadDocuments();
});
