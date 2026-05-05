import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GraphView } from './components/GraphView';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const markdownComponents = {
  h1: ({ children }) => <h1 className="text-2xl font-bold text-gray-0 mt-2 mb-1.5 border-b border-gray-750 pb-1.5 tracking-tight">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-semibold text-gray-100 mt-2 mb-1 tracking-tight">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-semibold text-gray-200 mt-1.5 mb-0.5">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed text-gray-300">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5 pl-1 text-gray-300">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5 pl-1 text-gray-300">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed text-gray-300">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-gray-0">{children}</strong>,
  em: ({ children }) => <em className="italic text-gray-400">{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="bg-gray-800 text-primary-300 text-xs font-mono px-1 py-0.5 rounded-xs">{children}</code>
    : <code className="block bg-gray-850 text-primary-300 text-xs font-mono p-1.5 rounded-md overflow-x-auto whitespace-pre border border-gray-750">{children}</code>,
  pre: ({ children }) => <pre className="mb-2 rounded-md overflow-hidden border border-gray-750">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-primary-500 pl-2 my-2 text-gray-400 italic">{children}</blockquote>,
  hr: () => <hr className="border-gray-750 my-2" />,
  table: ({ children }) => <div className="overflow-x-auto mb-2"><table className="w-full text-sm border-collapse">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-gray-850">{children}</thead>,
  th: ({ children }) => <th className="text-left px-2 py-1 text-primary-300 font-semibold border border-gray-750">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1 border border-gray-750 text-gray-300">{children}</td>,
  tr: ({ children }) => <tr className="even:bg-gray-850/40">{children}</tr>,
};

function App() {
  const [messages, setMessages] = useState([]);
  const [textIssue, setTextIssue] = useState("");
  const [image, setImage] = useState(null);
  const [audio, setAudio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [graphError, setGraphError] = useState(null);

  const [view, setView] = useState("chat");
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [hasConversationGraph, setHasConversationGraph] = useState(false);

  const chatEndRef = useRef(null);

  const resetConversation = () => {
    setMessages([]);
    setTextIssue("");
    setImage(null);
    setAudio(null);
    setError(null);
    setGraphError(null);
    setGraphData({ nodes: [], links: [] });
    setHasConversationGraph(false);
    setView("chat");
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    // Only fetch the full DB graph when no conversation-specific subgraph is active
    if (view === "graph" && !hasConversationGraph) {
      setGraphError(null);
      fetch(`${API_URL}/graph-data`)
        .then(res => res.json())
        .then(data => {
          if (data.error) {
            setGraphError(`Failed to load graph: ${data.error}`);
          } else {
            setGraphData(data);
          }
        })
        .catch(err => setGraphError(`Could not reach the server: ${err.message}`));
    }
  }, [view, hasConversationGraph]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Audio is now a valid standalone input — validate all three
    if (!image && !audio && !textIssue && messages.length === 0) {
      setError("Please provide an image, audio recording, or text description to start the diagnostic.");
      return;
    }

    setLoading(true);
    setError(null);

    // Show all submitted inputs in the chat bubble, not just the first one.
    const parts = [];
    if (textIssue) parts.push(textIssue);
    if (image) parts.push(`[Image: ${image.name}]`);
    if (audio) parts.push(`[Audio: ${audio.name}]`);
    const userDisplayMsg = parts.join("  ");

    const newMessages = [...messages, { role: "user", text: userDisplayMsg }];
    setMessages(newMessages);

    const geminiHistory = messages.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    }));

    const formData = new FormData();
    if (image) formData.append("image", image);
    if (audio) formData.append("audio", audio);
    if (textIssue) formData.append("text_issue", textIssue);
    formData.append("chat_history", JSON.stringify(geminiHistory));

    setTextIssue("");
    setImage(null);
    setAudio(null);

    try {
      const response = await fetch(`${API_URL}/diagnose`, {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      // Treat both HTTP error codes AND a backend error field as failures,
      // because unexpected exceptions return HTTP 500 via HTTPException now.
      if (!response.ok || data.error) {
        throw new Error(data.detail || data.error || "An error occurred.");
      }

      // Store image_url, identified_part and confidence alongside the AI text
      setMessages(prev => [...prev, {
        role: "model",
        text: data.ai_response,
        image_url: data.image_url || null,
        identified_part: data.identified_part || null,
        confidence: data.confidence || null,
      }]);

      if (data.graph_data) {
        setGraphData(data.graph_data);
        setHasConversationGraph(true);
        setGraphError(null);
      }

    } catch (err) {
      setError(err.message);
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto h-screen flex flex-col p-2">
      <header className="flex justify-between items-center py-3 px-2 mb-1.5">
        <div>
          <h1 className="text-primary-400 text-3xl font-bold tracking-tight">TorqueSense AI</h1>
          <p className="text-gray-500 text-sm font-normal">Interactive Diagnostic Dashboard</p>
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              id="new-diagnosis-btn"
              onClick={resetConversation}
              className="btn-primary text-sm flex items-center gap-1 px-3 py-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
              </svg>
              New Diagnosis
            </button>
          )}

          <div className="flex bg-gray-800 rounded-lg p-0.5 border border-gray-700/40 gap-0.5">
            <button
              onClick={() => setView('chat')}
              className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 text-sm ${
                view === 'chat'
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-300 hover:bg-gray-700/50'
              }`}
            >
              Chat Session
            </button>
            <button
              onClick={() => setView('graph')}
              className={`px-3 py-1.5 rounded-md font-medium transition-all duration-200 text-sm ${
                view === 'graph'
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-300 hover:bg-gray-700/50'
              }`}
            >
              Database Graph
            </button>
          </div>
        </div>
      </header>

      {view === 'chat' ? (
        <>
          <main className="flex-grow bg-gradient-to-b from-gray-850 to-gray-900 rounded-2xl overflow-y-auto p-4 mb-2 flex flex-col gap-3 border border-gray-700/40 shadow-lg animate-slideDown">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full animate-fadeIn">
                <div className="text-center">
                  <div className="w-16 h-16 rounded-2xl bg-gray-800/60 border border-gray-700/30 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <p className="text-gray-400 text-base font-medium">Start a diagnostic</p>
                  <p className="text-gray-600 text-sm mt-1">Upload an image, record audio, or describe your car issue</p>
                </div>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-slideInUp`}>
                  {msg.role === 'user' ? (
                    <div className="max-w-[75%] rounded-2xl px-4 py-2.5 bg-primary-600 text-white rounded-tr-none shadow-sm hover:shadow-md hover:scale-105 transition-all duration-200 origin-bottom-right cursor-default">
                      <p className="text-sm leading-relaxed">{msg.text}</p>
                    </div>
                  ) : (
                    <div className="max-w-[75%] rounded-2xl bg-gray-800 border border-gray-700/50 rounded-tl-none shadow-sm hover:shadow-md hover:border-gray-700 transition-all duration-200 overflow-hidden origin-top-left">

                      {/* Component image + diagnosis section */}
                      {msg.identified_part && msg.identified_part !== "Continuing Conversation" && (
                        <div className="px-4 py-3 border-b border-gray-700/30 bg-gray-750/50">
                          {msg.image_url && (
                            <img
                              src={msg.image_url}
                              alt={msg.identified_part}
                              className="w-full rounded-lg mb-2.5 object-cover border border-gray-700/40 transition-all duration-200 hover:border-gray-700"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="inline-flex items-center gap-1.5 bg-warning-600/15 text-warning-300 border border-warning-600/30 text-xs font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:bg-warning-600/25">
                                <span className="w-1.5 h-1.5 rounded-full bg-warning-400"></span>
                                {msg.identified_part}
                              </span>
                              {msg.confidence && (
                                <span className="inline-flex items-center gap-1.5 bg-success-600/15 text-success-300 border border-success-600/30 text-xs font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:bg-success-600/25">
                                  <span className="w-1.5 h-1.5 rounded-full bg-success-400"></span>
                                  {(msg.confidence * 100).toFixed(0)}% match
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* AI response text — card styled */}
                      <div className="px-4 py-3 text-gray-300 text-sm leading-relaxed">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {msg.text}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}

            {loading && (
              <div className="flex justify-start animate-slideInUp">
                <div className="bg-gray-800 border border-gray-700/50 text-gray-400 px-4 py-2.5 rounded-2xl rounded-tl-none animate-pulse text-sm shadow-sm">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{animationDelay: '0ms'}}></span>
                      <span className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{animationDelay: '150ms'}}></span>
                      <span className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{animationDelay: '300ms'}}></span>
                    </div>
                    <span>Analyzing...</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </main>

          <footer className="bg-gradient-to-t from-gray-850 to-gray-800 p-3 rounded-2xl border border-gray-700/40 shadow-lg backdrop-blur-sm animate-slideDown" style={{animationDelay: '50ms'}}>
            {error && (
              <div className="mb-2 p-2.5 bg-error-600/15 border border-error-600/30 text-error-300 rounded-lg text-xs font-medium animate-slideInUp">
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} className="flex flex-col gap-2">
              <div className="flex gap-2 text-xs">
                <div className="flex-1">
                  <label className="block text-gray-500 mb-1 font-medium text-[11px]">Image</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={e => setImage(e.target.files[0])}
                    className="w-full text-gray-400 text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-gray-700/50 file:text-gray-300 hover:file:bg-gray-700 transition-colors duration-200"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-gray-500 mb-1 font-medium text-[11px]">Audio</label>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={e => setAudio(e.target.files[0])}
                    className="w-full text-gray-400 text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-gray-700/50 file:text-gray-300 hover:file:bg-gray-700 transition-colors duration-200"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={textIssue}
                  onChange={(e) => setTextIssue(e.target.value)}
                  placeholder="Describe your issue or ask a follow-up question..."
                  className="flex-grow px-4 py-2.5 bg-gray-750 border border-gray-600/50 rounded-full text-gray-0 placeholder-gray-600 text-sm focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition-all duration-200 hover:border-gray-600"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary-pill text-sm flex-shrink-0"
                >
                  Send
                </button>
              </div>
            </form>
          </footer>
        </>
      ) : (
        <div className="flex-grow flex flex-col animate-slideDown">
          {graphError && (
            <div className="mb-2 p-2.5 bg-error-600/15 border border-error-600/30 text-error-300 rounded-lg text-sm font-medium animate-slideInUp">
              {graphError}
            </div>
          )}
          <GraphView graphData={graphData} hasConversationGraph={hasConversationGraph} />
        </div>
      )}
    </div>
  );
}

export default App;
