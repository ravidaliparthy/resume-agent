import { Agent, routeAgentRequest, callable } from "agents";
import {
  llm, runPipeline, textToPdf, bytesToBase64,
  type AiEnv, type OptimizeInput, type OptimizeResult,
} from "./pipeline";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface AgentState {
  messages: ChatMessage[];
  busy: boolean;
  progress: string[];
  result: OptimizeResult | null;
  error: string;
}

interface Env extends AiEnv {
  ResumeAgent: DurableObjectNamespace<ResumeAgent>;
}

const MAX_STORED = 60;   // messages kept in durable state
const MAX_CONTEXT = 14;  // messages sent to the model each turn

const SYSTEM_PROMPT = `You are a friendly, precise career assistant that helps people improve their resumes.
You can chat about resumes, job applications and interview preparation. The user also has a "Resume tools"
panel that tailors a resume to a job description and scores it. When results from that panel are provided
below, use them to answer follow-up questions. Never invent experience, employers, tools or metrics for the
user. If you are unsure, say so and ask.`;

export class ResumeAgent extends Agent<Env, AgentState> {
  // Persisted in this agent's SQLite storage and synced to every connected client.
  initialState: AgentState = { messages: [], busy: false, progress: [], result: null, error: "" };

  private push(role: ChatMessage["role"], content: string) {
    const messages = [...this.state.messages, { role, content, at: Date.now() }].slice(-MAX_STORED);
    this.setState({ ...this.state, messages });
  }

  /** Conversational turn. History lives in agent state, so it survives refreshes, restarts and deploys. */
  @callable()
  async chat(message: string): Promise<string> {
    const text = String(message ?? "").trim();
    if (!text) throw new Error("Message is empty");
    if (text.length > 8000) throw new Error("Message is too long (max 8000 characters)");

    this.push("user", text);
    const { result } = this.state;
    const context = result
      ? `\n\nLatest resume tool output:\n--- TAILORED RESUME ---\n${result.tailoredResume.slice(0, 4000) || "(none, score-only run)"}\n--- REPORT ---\n${result.report.slice(0, 4000)}`
      : "";
    try {
      const history = this.state.messages.slice(-MAX_CONTEXT).map(({ role, content }) => ({ role, content }));
      const reply = await llm(this.env, [{ role: "system", content: SYSTEM_PROMPT + context }, ...history], 1024, 0.5);
      this.push("assistant", reply);
      return reply;
    } catch (e: any) {
      this.push("assistant", `Sorry, I hit an error talking to the model: ${e.message}`);
      throw e;
    }
  }

  /** Runs the full tailor + score pipeline. Progress streams to the UI through state updates. */
  @callable()
  async optimize(raw: Partial<OptimizeInput>): Promise<OptimizeResult> {
    if (this.state.busy) throw new Error("A resume job is already running. Please wait for it to finish.");

    const input: OptimizeInput = {
      resume_text: String(raw.resume_text ?? "").trim(),
      job_description: String(raw.job_description ?? "").trim(),
      target_role: raw.target_role?.trim() || "Not specified",
      target_company: raw.target_company?.trim() || "",
      mode: raw.mode === "score_only" ? "score_only" : "tailor_and_score",
      email: String(raw.email ?? "").trim(),
    };
    if (input.resume_text.length <= 50) throw new Error("MISSING_REQUIRED_FIELDS: resume_text must be at least 50 characters.");
    if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) throw new Error("That email address does not look valid.");

    this.setState({ ...this.state, busy: true, progress: ["Starting…"], error: "", result: null });
    try {
      const result = await runPipeline(this.env, input, (msg) =>
        this.setState({ ...this.state, progress: [...this.state.progress, msg] }));
      this.setState({ ...this.state, busy: false, result, progress: [...this.state.progress, "Done."] });
      this.push("assistant",
        result.mode === "tailor_and_score"
          ? "I tailored your resume and scored it against the job description. Ask me anything about the results."
          : "I scored your resume. Ask me anything about the report.");
      return result;
    } catch (e: any) {
      this.setState({ ...this.state, busy: false, error: e.message });
      throw e;
    }
  }

  /** Returns a PDF (base64) of the last result so the browser can download it without Gmail. */
  @callable()
  async getPdf(kind: "resume" | "report"): Promise<string> {
    const r = this.state.result;
    if (!r) throw new Error("Run the resume tools first.");
    const text = kind === "resume" ? r.tailoredResume : r.report;
    if (!text) throw new Error("That document is not available for this run.");
    return bytesToBase64(await textToPdf(text, kind === "resume" ? "Tailored Resume" : "Report"));
  }

  @callable()
  clearChat(): void {
    this.setState({ ...this.initialState });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
