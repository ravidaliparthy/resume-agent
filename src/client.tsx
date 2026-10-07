import "./styles.css";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { ResumeAgent, AgentState } from "./server";

const sessionId = (() => {
  try {
    const existing = localStorage.getItem("sessionId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem("sessionId", id);
    return id;
  } catch { return "default"; }
})();

const EMPTY: AgentState = { messages: [], busy: false, progress: [], result: null, error: "" };

function downloadBase64Pdf(b64: string, filename: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [state, setState] = useState<AgentState>(EMPTY);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    resume_text: "", job_description: "", target_role: "", target_company: "", email: "",
    mode: "tailor_and_score" as "tailor_and_score" | "score_only",
  });
  const endRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<ResumeAgent, AgentState>({
    agent: "ResumeAgent",
    name: sessionId,
    onStateUpdate: setState,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state.messages.length, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput(""); setErr(""); setSending(true);
    try { await agent.stub.chat(text); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSending(false); }
  }

  async function run() {
    setErr("");
    try { await agent.stub.optimize(form); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  async function download(kind: "resume" | "report") {
    try { downloadBase64Pdf(await agent.stub.getPdf(kind), kind === "resume" ? "tailored-resume.pdf" : "report.pdf"); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const r = state.result;
  return (
    <div className="layout">
      <section className="chat">
        <header>
          <h1>Resume Agent <span className={connected ? "dot on" : "dot"} title={connected ? "Connected" : "Connecting…"} /></h1>
          <button className="ghost" onClick={() => agent.stub.clearChat().catch((e: any) => setErr(e.message))}>Clear chat</button>
        </header>
        <div className="messages" aria-live="polite">
          {state.messages.length === 0 && (
            <div className="msg bot">Hi! I'm a Llama 3.3 resume assistant running on Cloudflare. Chat with me, or use the Resume tools panel to tailor and score a resume. I remember this conversation across refreshes.</div>
          )}
          {state.messages.map((m) => <div key={m.at + m.role} className={`msg ${m.role === "user" ? "user" : "bot"}`}>{m.content}</div>)}
          {sending && <div className="msg bot typing">Thinking…</div>}
          <div ref={endRef} />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea rows={1} value={input} placeholder="Ask about your resume… (Enter to send)" disabled={!connected}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <button type="submit" disabled={sending || !connected || !input.trim()}>Send</button>
        </form>
      </section>

      <aside className="tools">
        <h2>Resume tools</h2>
        <label>Resume text<textarea rows={8} value={form.resume_text} onChange={set("resume_text")} placeholder="Paste your resume (50+ characters)" /></label>
        <label>Job description (optional, enables tailoring)<textarea rows={6} value={form.job_description} onChange={set("job_description")} /></label>
        <div className="row">
          <label>Target role<input value={form.target_role} onChange={set("target_role")} /></label>
          <label>Target company<input value={form.target_company} onChange={set("target_company")} /></label>
        </div>
        <div className="row">
          <label>Email results to<input type="email" value={form.email} onChange={set("email")} placeholder="you@example.com" /></label>
          <label>Mode
            <select value={form.mode} onChange={set("mode")}>
              <option value="tailor_and_score">Tailor + score</option>
              <option value="score_only">Score only</option>
            </select>
          </label>
        </div>
        <button className="primary" onClick={run} disabled={state.busy || !connected}>{state.busy ? "Working…" : "Run"}</button>

        {(state.busy || state.progress.length > 0) && (
          <ul className="progress">{state.progress.map((p, i) => <li key={i}>{p}</li>)}</ul>
        )}
        {(err || state.error) && <div className="error">{err || state.error}</div>}

        {r && (
          <div className="result">
            <p className="note">{r.emailed ? "Emailed to you." : r.emailNote}</p>
            {r.warnings?.length > 0 && (
              <div className="error"><strong>Review before using this resume:</strong>
                <ul>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            <div className="row">
              {r.tailoredResume && <button onClick={() => download("resume")}>Download resume PDF</button>}
              <button onClick={() => download("report")}>Download report PDF</button>
            </div>
            {r.tailoredResume && <details open><summary>Tailored resume</summary><pre>{r.tailoredResume}</pre></details>}
            <details open><summary>Report</summary><pre>{r.report}</pre></details>
          </div>
        )}
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
