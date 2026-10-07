import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  TAILOR_SYSTEM, PROOFREADER_SYSTEM, JD_SCORER_SYSTEM, GENERAL_SCORER_SYSTEM, SECTION_HEADERS,
  buildCorrectionPrompt, issueWarnings, type Issue,
} from "./prompts";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_RETRIES = 1; // same as n8n "IF - Retry Limit Not Exceeded"

export interface GmailEnv {
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_SENDER?: string;
}
export interface AiEnv extends GmailEnv {
  AI: Ai;
}

export interface OptimizeInput {
  resume_text: string;
  job_description: string;
  target_role: string;
  target_company: string;
  mode: "tailor_and_score" | "score_only";
  email: string;
}

export interface OptimizeResult {
  mode: OptimizeInput["mode"];
  tailoredResume: string;
  report: string;
  emailed: boolean;
  emailNote: string;
  /** Quality warnings about the tailored resume (empty when everything checked out). */
  warnings: string[];
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

/* --------------------------- LLM (Workers AI) --------------------------- */

export async function llm(env: AiEnv, messages: Msg[], maxTokens = 1024, temperature = 0.4): Promise<string> {
  if (!env.AI) throw new Error("The Workers AI binding 'AI' is missing. Check wrangler.jsonc and, for local dev, run `npx wrangler login`.");
  // Model id typing differs across @cloudflare/workers-types versions, so call through a loose type.
  const result: any = await (env.AI as any).run(MODEL, { messages, max_tokens: maxTokens, temperature });
  const out = typeof result === "string" ? result : result?.response;
  if (typeof out !== "string" || !out.trim()) throw new Error("Workers AI returned an empty response");
  return out.trim();
}

const runAgent = (env: AiEnv, system: string, user: string, maxTokens: number, temperature: number) =>
  llm(env, [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, temperature);

const tailor = (env: AiEnv, i: OptimizeInput, retryNote: string) =>
  runAgent(env, TAILOR_SYSTEM,
    `Resume:\n${i.resume_text}\n\nTarget Role: ${i.target_role}\nTarget Company: ${i.target_company}\n` +
    `Job Description: ${i.job_description}` + (retryNote ? `\n\nIMPORTANT CORRECTION NEEDED: ${retryNote}` : ""),
    6000, 0.2);

const proofread = (env: AiEnv, resume: string) => runAgent(env, PROOFREADER_SYSTEM, resume, 6000, 0.1);

const jdScore = (env: AiEnv, i: OptimizeInput) =>
  runAgent(env, JD_SCORER_SYSTEM,
    `Resume:\n${i.resume_text}\n\nTarget Role: ${i.target_role}\nTarget Company: ${i.target_company}\n` +
    `Job Description: ${i.job_description}`, 3000, 0.2);

const generalScore = (env: AiEnv, i: OptimizeInput) =>
  runAgent(env, GENERAL_SCORER_SYSTEM, `Resume:\n${i.resume_text}\n\nTarget Role (optional): ${i.target_role}`, 3000, 0.2);

/* ------------------------------ Parsing ------------------------------- */

export const escapeHtml = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ResumeSection { header: string; body: string }
export interface ResumeFields {
  candidateName: string;
  contactInfo: string;
  headerBlock: string;
  sections: ResumeSection[];
}

/** Splits a resume on the known all-caps section headers (exact line match, optional trailing colon). */
export function parseResume(text: string): ResumeFields {
  const known = new Set<string>(SECTION_HEADERS);
  const lines = text.replace(/\r/g, "").split("\n");
  const head: string[] = [];
  const sections: ResumeSection[] = [];
  let cur: { header: string; lines: string[] } | null = null;
  for (const line of lines) {
    const candidate = line.trim().replace(/:$/, "");
    if (known.has(candidate)) {
      if (cur) sections.push({ header: cur.header, body: cur.lines.join("\n").trim() });
      cur = { header: candidate, lines: [] };
    } else if (cur) cur.lines.push(line);
    else head.push(line);
  }
  if (cur) sections.push({ header: cur.header, body: cur.lines.join("\n").trim() });
  const headerLines = head.filter((l) => l.trim());
  return {
    candidateName: headerLines[0]?.trim() || "Candidate",
    contactInfo: headerLines.slice(1).map((l) => l.trim()).join(" | "),
    headerBlock: head.join("\n").trim(),
    sections,
  };
}

const section = (f: ResumeFields, header: string) => f.sections.find((x) => x.header === header)?.body ?? "";

const nums = (t: string) =>
  (t.replace(/\[Metric:[^\]]*\]/gi, "").match(/\d+(?:[.,:]\d+)*/g) ?? []).map((n) => n.replace(/,/g, "").replace(/[.:]$/, ""));

/** Source sections that must survive tailoring: [pattern in source resume, header expected in output]. */
const MUST_KEEP: [RegExp, string][] = [
  [/^\s*projects?\b/im, "PROJECTS"],
  [/^\s*certifications?\b/im, "CERTIFICATIONS"],
  [/^\s*leadership\b/im, "LEADERSHIP"],
  [/^\s*(achievements?|publications?|research)\b/im, "ACHIEVEMENTS & RESEARCH"],
];

/**
 * Checks the tailored resume against the submitted one. `structural` issues mean the output cannot be
 * used at all; `quality` issues are fixable and become warnings if the retry does not clear them.
 * The wording for each issue lives in CORRECTIONS (prompts.ts).
 */
export function validateTailored(source: string, tailored: string, f: ResumeFields) {
  const structural: Issue[] = [];
  const quality: Issue[] = [];

  if (section(f, "PROFESSIONAL SUMMARY").length <= 20) structural.push({ code: "MISSING_SUMMARY" });
  if (section(f, "SKILLS").length <= 5) structural.push({ code: "MISSING_SKILLS" });
  if (section(f, "PROJECTS").length <= 20 && section(f, "EXPERIENCE").length <= 20) structural.push({ code: "MISSING_BODY" });

  if (/\b(I|my|me|I'm|I've)\b/.test(section(f, "PROFESSIONAL SUMMARY"))) quality.push({ code: "FIRST_PERSON" });

  const sourceNums = new Set(nums(source));
  const bad = [...new Set(nums(tailored).filter((n) => !sourceNums.has(n)))];
  if (bad.length) quality.push({ code: "INVENTED_NUMBERS", detail: bad.slice(0, 12).join(", ") });

  const hasHeader = (h: string) => f.sections.some((x) => x.header === h);
  for (const [re, header] of MUST_KEEP)
    if (re.test(source) && !hasHeader(header)) quality.push({ code: "DROPPED_SECTION", detail: header });

  const sourceHasExperience = /^\s*(work\s+)?experience\b|^\s*employment\b/im.test(source);
  if (hasHeader("EXPERIENCE") && !sourceHasExperience) quality.push({ code: "INVENTED_EXPERIENCE" });

  return { structural, quality };
}

const BULLET_HEADERS = new Set(["EXPERIENCE", "PROJECTS"]);

function renderSectionHtml(sec: ResumeSection): string {
  if (sec.header === "PROFESSIONAL SUMMARY" || sec.header === "SKILLS") return `<p>${escapeHtml(sec.body).replace(/\n/g, "<br>")}</p>`;
  let html = "", inList = false;
  for (const raw of sec.body.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("-")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${escapeHtml(t.replace(/^-\s*/, ""))}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += BULLET_HEADERS.has(sec.header) ? `<h3>${escapeHtml(t)}</h3>` : `<p>${escapeHtml(t)}</p>`;
    }
  }
  return inList ? html + "</ul>" : html;
}

const titleCase = (h: string) => h.charAt(0) + h.slice(1).toLowerCase();

export function resumeToHtml(f: ResumeFields): string {
  return `<h1>${escapeHtml(f.candidateName)}</h1><p>${escapeHtml(f.contactInfo)}</p>` +
    f.sections.map((x) => `<h2>${escapeHtml(titleCase(x.header))}</h2>${renderSectionHtml(x)}`).join("");
}

/* -------------------------------- PDF --------------------------------- */

export async function textToPdf(text: string, title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const PAGE: [number, number] = [595.28, 841.89];
  const M = 50, SIZE = 10.5, LEAD = 15, maxW = PAGE[0] - M * 2;

  const clean = (s: string) =>
    s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "...").replace(/[\u2022\u25CF]/g, "-").replace(/\t/g, "    ")
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

  const wrap = (line: string, f: typeof font) => {
    const lines: string[] = [];
    let cur = "";
    for (const w of line.split(" ")) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, SIZE) <= maxW) { cur = next; continue; }
      if (cur) lines.push(cur);
      let chunk = w;
      while (f.widthOfTextAtSize(chunk, SIZE) > maxW) {
        let i = chunk.length;
        while (i > 1 && f.widthOfTextAtSize(chunk.slice(0, i), SIZE) > maxW) i--;
        lines.push(chunk.slice(0, i));
        chunk = chunk.slice(i);
      }
      cur = chunk;
    }
    lines.push(cur);
    return lines;
  };

  let page = pdf.addPage(PAGE);
  let y = PAGE[1] - M;
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = clean(rawLine);
    const f = /^[A-Z][A-Z &/]{3,}$/.test(line.trim()) ? bold : font;
    for (const piece of line.trim() === "" ? [""] : wrap(line, f)) {
      if (y < M) { page = pdf.addPage(PAGE); y = PAGE[1] - M; }
      if (piece) page.drawText(piece, { x: M, y, size: SIZE, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= LEAD;
    }
  }
  return pdf.save();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ------------------------------- Gmail -------------------------------- */

export const gmailConfigured = (e: GmailEnv) =>
  Boolean(e.GMAIL_CLIENT_ID && e.GMAIL_CLIENT_SECRET && e.GMAIL_REFRESH_TOKEN && e.GMAIL_SENDER);

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

async function gmailToken(env: GmailEnv): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!, client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!, grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Gmail auth failed: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

export interface Attachment { filename: string; bytes: Uint8Array }

export async function sendGmail(
  env: GmailEnv,
  { to, subject, html, attachments = [] }: { to: string; subject: string; html: string; attachments?: Attachment[] },
): Promise<void> {
  const token = await gmailToken(env);
  const boundary = `b_${crypto.randomUUID()}`;
  const parts = [
    `From: ${env.GMAIL_SENDER}`, `To: ${to}`,
    `Subject: =?UTF-8?B?${bytesToBase64(utf8(subject))}?=`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    wrap76(bytesToBase64(utf8(html))),
  ];
  for (const a of attachments) {
    parts.push(`--${boundary}`, `Content-Type: application/pdf; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.filename}"`, "",
      wrap76(bytesToBase64(a.bytes)));
  }
  parts.push(`--${boundary}--`, "");
  const raw = b64url(bytesToBase64(utf8(parts.join("\r\n"))));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
}

/* ------------------------------ Pipeline ------------------------------ */

/**
 * Full n8n pipeline: [PDF of submitted text emailed] -> tailor -> proofread -> parse (+1 retry)
 * in parallel with the scorer -> merge -> email. score_only/no-JD goes to the general scorer -> email.
 */
export async function runPipeline(
  env: AiEnv, input: OptimizeInput, progress: (msg: string) => void,
): Promise<OptimizeResult> {
  const canEmail = Boolean(input.email) && gmailConfigured(env);
  let emailNote = !input.email ? "No email address given, so nothing was sent."
    : !canEmail ? "Gmail secrets are not configured, so no email was sent." : "";
  let emailed = false;

  // Start of flow: export the submitted text to PDF and email it.
  if (canEmail) {
    progress("Emailing a PDF copy of your submitted resume…");
    try {
      await sendGmail(env, {
        to: input.email, subject: "Your submitted resume (PDF copy)",
        html: "<p>Attached is a PDF copy of the resume text you submitted. Your analysis follows in a separate email.</p>",
        attachments: [{ filename: "submitted-resume.pdf", bytes: await textToPdf(input.resume_text, "Submitted Resume") }],
      });
      emailed = true;
    } catch (e: any) { emailNote = `Start-of-flow email failed: ${e.message}`; }
  }

  const tailorPath = input.job_description.length > 50 && input.mode !== "score_only";

  if (!tailorPath) {
    progress("Scoring your resume (no job description)…");
    const report = await generalScore(env, input);
    if (canEmail) {
      progress("Emailing the score report…");
      try {
        await sendGmail(env, {
          to: input.email, subject: "Your Resume Score Report",
          html: `<h2>Resume Score Report</h2><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(report)}</pre>`,
          attachments: [{ filename: "score-report.pdf", bytes: await textToPdf(report, "Resume Score Report") }],
        });
        emailed = true;
      } catch (e: any) { emailNote = `Score email failed: ${e.message}`; }
    }
    return { mode: "score_only", tailoredResume: "", report, emailed, emailNote, warnings: [] };
  }

  progress("Tailoring and scoring in parallel…");
  const scorer = jdScore(env, input);
  scorer.catch(() => {});

  let fields: ResumeFields | null = null, tailored = "", note = "";
  let warnings: string[] = [];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    progress(attempt === 0 ? "Writing the tailored resume…" : "Quality check failed, rewriting once…");
    const candidate = await proofread(env, await tailor(env, input, note));
    const parsed = parseResume(candidate);
    const { structural, quality } = validateTailored(input.resume_text, candidate, parsed);
    if (structural.length === 0) { fields = parsed; tailored = candidate; warnings = issueWarnings(quality); }
    if (structural.length === 0 && quality.length === 0) break;
    note = buildCorrectionPrompt([...structural, ...quality]);
  }
  if (!fields) {
    throw new Error("RESUME_FORMAT_RETRY_EXHAUSTED: the tailored resume could not be parsed into the required sections after a retry. Try again or shorten the resume.");
  }
  if (warnings.length) progress(`Finished with ${warnings.length} warning(s), see the result panel.`);

  progress("Waiting for the fit analysis…");
  const report = await scorer;

  if (canEmail) {
    progress("Emailing the tailored resume and report…");
    try {
      const warn = warnings.length
        ? `<p><b>Review before sending:</b></p><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul><hr>` : "";
      const html = warn + resumeToHtml(fields) +
        `<hr><h2>Fit Analysis &amp; Score Report</h2><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(report)}</pre>`;
      await sendGmail(env, {
        to: input.email, subject: `Your Tailored Resume - ${input.target_role}`, html,
        attachments: [
          { filename: "tailored-resume.pdf", bytes: await textToPdf(tailored, "Tailored Resume") },
          { filename: "fit-analysis.pdf", bytes: await textToPdf(report, "Fit Analysis") },
        ],
      });
      emailed = true;
    } catch (e: any) { emailNote = `Final email failed: ${e.message}`; }
  }
  return { mode: "tailor_and_score", tailoredResume: tailored, report, emailed, emailNote, warnings };
}
