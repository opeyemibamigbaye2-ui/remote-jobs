// Fetches remote developer jobs and emails the ones posted recently.
// Runs on GitHub Actions (Node 18+). Needs the nodemailer package.

const nodemailer = require("nodemailer");

const HOURS = Number(process.env.HOURS || 26);            // look-back window (a little over a day avoids gaps)
const WORLDWIDE_ONLY = process.env.WORLDWIDE_ONLY === "true";
const EXCLUDE = (process.env.EXCLUDE_WORDS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const ROLES = [
  { id: "software",  label: "Software developer",   re: /software\s*(developer|engineer)|\bdeveloper\b|\bprogrammer\b|\bsde\b|\bswe\b/i },
  { id: "frontend",  label: "Frontend engineer",    re: /front[\s-]?end|ui\s*(engineer|developer)|\breact\b|\bvue\b|\bangular\b/i },
  { id: "backend",   label: "Backend engineer",     re: /back[\s-]?end|server[\s-]?side|\bapi\s*(engineer|developer)|\bnode(\.js)?\b|\bgolang\b|\bpython\b|\bjava\b|\bruby\b|\bphp\b|\.net\b/i },
  { id: "fullstack", label: "Full stack developer", re: /full[\s-]?stack/i },
];

function parseDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  let s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) { const n = +s; return new Date(n < 1e12 ? n * 1000 : n); }
  s = s.replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "remote-jobs-daily-alert", "Accept": "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

const SOURCES = [
  { name: "Remotive", run: async () => {
    const d = await getJSON("https://remotive.com/api/remote-jobs?category=software-dev&limit=300");
    return (d.jobs || []).map(j => ({ title: j.title, company: j.company_name, url: j.url, date: parseDate(j.publication_date),
      location: j.candidate_required_location || "", tags: j.tags || [], source: "Remotive" }));
  }},
  { name: "Arbeitnow", run: async () => {
    const d = await getJSON("https://www.arbeitnow.com/api/job-board-api");
    return (d.data || []).filter(j => j.remote).map(j => ({ title: j.title, company: j.company_name, url: j.url, date: parseDate(j.created_at),
      location: j.location || "", tags: j.tags || [], source: "Arbeitnow" }));
  }},
  { name: "Jobicy", run: async () => {
    const d = await getJSON("https://jobicy.com/api/v2/remote-jobs?count=100&industry=dev");
    return (d.jobs || []).map(j => ({ title: j.jobTitle, company: j.companyName, url: j.url, date: parseDate(j.pubDate),
      location: Array.isArray(j.jobGeo) ? j.jobGeo.join(", ") : (j.jobGeo || ""), tags: [], source: "Jobicy" }));
  }},
  { name: "Remote OK", run: async () => {
    const d = await getJSON("https://remoteok.com/api");
    return (Array.isArray(d) ? d : []).filter(j => j && j.position).map(j => ({ title: j.position, company: j.company, url: j.url || j.apply_url,
      date: parseDate(j.date || j.epoch), location: j.location || "", tags: j.tags || [], source: "Remote OK" }));
  }},
];

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => (/^https?:\/\//i.test(u || "") ? u : "#");
const isWorldwide = loc => !loc || /worldwide|anywhere|global|world\b|any\s*location|remote$/i.test(loc.trim());

function rolesFor(j) {
  const hay = j.title + " " + (j.tags || []).join(" ");
  return ROLES.filter(r => r.re.test(j.title) || (r.id !== "software" && r.re.test(hay))).map(r => r.label);
}

function ageText(d) {
  const h = (Date.now() - d.getTime()) / 36e5;
  if (h < 1) return "just now";
  if (h < 24) return Math.floor(h) + "h ago";
  return Math.floor(h / 24) + "d ago";
}

async function main() {
  const { SMTP_USER, SMTP_PASS, MAIL_TO } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    throw new Error("Missing SMTP_USER, SMTP_PASS or MAIL_TO. Add them as repository secrets.");
  }

  const results = await Promise.all(SOURCES.map(async s => {
    try { return { name: s.name, ok: true, jobs: await s.run() }; }
    catch (e) { console.warn(s.name + " failed:", e.message); return { name: s.name, ok: false, jobs: [] }; }
  }));
  if (!results.some(r => r.ok)) throw new Error("Every job source failed.");

  const cutoff = Date.now() - HOURS * 36e5;
  const seen = new Set();
  const jobs = [];
  for (const r of results) {
    for (const j of r.jobs) {
      if (!j.title || !j.date || j.date.getTime() < cutoff) continue;
      j.roles = rolesFor(j);
      if (!j.roles.length) continue;
      if (WORLDWIDE_ONLY && !isWorldwide(j.location)) continue;
      const head = (j.title + " " + (j.company || "")).toLowerCase();
      if (EXCLUDE.some(w => head.includes(w))) continue;
      const key = ((j.company || "") + "|" + j.title).toLowerCase().replace(/[^a-z0-9|]/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(j);
    }
  }
  jobs.sort((a, b) => b.date - a.date);
  console.log(`Found ${jobs.length} listings in the last ${HOURS}h.`);
  if (!jobs.length) { console.log("Nothing to send today."); return; }

  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">${jobs.length} new remote developer ${jobs.length === 1 ? "job" : "jobs"}</h2>
    <p style="color:#666;margin:0 0 16px">Posted in the last ${HOURS} hours, newest first.</p>
    ${jobs.map(j => `<p style="margin:0 0 14px">
      <a href="${esc(safeUrl(j.url))}" style="font-size:16px;font-weight:bold">${esc(j.title)}</a><br>
      <span style="color:#555">${esc(j.company || "Company not listed")} · ${esc(j.location || "Location not listed")}</span><br>
      <span style="color:#888;font-size:13px">${esc(ageText(j.date))} · ${esc(j.source)} · ${esc(j.roles.join(", "))}</span></p>`).join("")}
  </div>`;
  const text = jobs.map(j => `${j.title}\n${j.company || ""} | ${j.location || ""} | ${ageText(j.date)} | ${j.source}\n${j.url}`).join("\n\n");

  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `Remote jobs <${SMTP_USER}>`,
    to: MAIL_TO,
    subject: `${jobs.length} new remote dev ${jobs.length === 1 ? "job" : "jobs"} today`,
    text,
    html,
  });
  console.log("Email sent to " + MAIL_TO);
}

main().catch(e => { console.error(e); process.exit(1); });
