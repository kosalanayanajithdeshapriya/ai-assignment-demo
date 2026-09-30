// ================== Task / prompt definitions ==================
// All prompts end with MARKER_INSTRUCTIONS below. This asks the AI to mark
// indentation with literal ">" characters instead of real spaces, because
// copy-pasting from some chat UIs silently strips leading whitespace, which
// otherwise makes the reconstructed Python invalid or subtly wrong (a
// dedented "return" ends up nested one level too deep, etc.). ">" survives
// copy-paste since it is an ordinary visible character, so this guarantees
// perfect reconstruction regardless of what the browser does to whitespace.
const MARKER_INSTRUCTIONS = `
IMPORTANT FORMATTING RULE (to survive copy-paste): do not use spaces or tabs
for indentation. Instead, prefix each indented line with one "." character
per indentation level (so a line one level deep starts with ".", two levels
deep starts with "..", and so on), followed by a single space then the code.
The "def ..." line itself has no "." prefix. Put the answer in a code block.
Example for a different function:

def example(x):
. if x > 0:
.. return True
. return False

Return ONLY the function code in this exact "."-marked style, no explanation.`;

const TASKS = [
  {
    id: 1,
    key: "task1",
    name: "has_close_elements",
    prompt:
`Write a Python function with this exact signature:

def has_close_elements(numbers, threshold):

It should return True if any two elements in the list "numbers" are closer
to each other than "threshold" (i.e. abs(a - b) < threshold for some pair),
otherwise return False.
${MARKER_INSTRUCTIONS}`,
    tests: [
      { argsExpr: "[1.0, 2.0, 3.0], 0.5", label: "([1.0, 2.0, 3.0], 0.5)", expected: false },
      { argsExpr: "[1.0, 2.8, 3.0], 0.3", label: "([1.0, 2.8, 3.0], 0.3)", expected: true },
    ],
  },
  {
    id: 2,
    key: "task2",
    name: "below_zero",
    prompt:
`Write a Python function with this exact signature:

def below_zero(operations):

"operations" is a list of integers representing deposits (positive) and
withdrawals (negative) applied in order to a bank account that starts at
balance 0. Return True if the running balance ever goes below zero at any
point during the sequence, otherwise return False.
${MARKER_INSTRUCTIONS}`,
    tests: [
      { argsExpr: "[1, 2, 3]", label: "[1, 2, 3]", expected: false },
      { argsExpr: "[1, 2, -4, 5]", label: "[1, 2, -4, 5]", expected: true },
    ],
  },
  {
    id: 3,
    key: "task3",
    name: "sum_product",
    prompt:
`Write a Python function with this exact signature:

def sum_product(numbers):

Return a tuple (sum, product) of all elements in the list "numbers".
For an empty list, return (0, 1).
${MARKER_INSTRUCTIONS}`,
    tests: [
      { argsExpr: "[]", label: "[]", expected: [0, 1] },
      { argsExpr: "[1, 2, 3, 4]", label: "[1, 2, 3, 4]", expected: [10, 24] },
    ],
  },
  {
    id: 4,
    key: "task4",
    name: "second_largest",
    prompt:
`Write a Python function with this exact signature:

def second_largest(numbers):

Return the second largest number in the list. If there is no second largest, return None.
${MARKER_INSTRUCTIONS}`,
    tests: [
      { argsExpr: "[5, 1, 5, 3, 2]", label: "[5, 1, 5, 3, 2]", expected: 3 },
      { argsExpr: "[7, 7]", label: "[7, 7]", expected: null },
    ],
  },
];

const TOOLS = [
  { key: "chatgpt", label: "ChatGPT" },
  { key: "claude", label: "Claude" },
];

// Example (buggy/correct) code from the report, used only for the optional
// "Fill Example Data" convenience button — not required for the real workflow.
const EXAMPLE_CODE = {
  task1_chatgpt: `def has_close_elements(numbers, threshold):\n    for i in range(len(numbers)):\n        for j in range(i + 1, len(numbers)):\n            if abs(numbers[i] - numbers[j]) < threshold:\n                return True\n    return False`,
  task1_claude: `def has_close_elements(numbers, threshold):\n    for i in range(len(numbers)):\n        for j in range(i + 1, len(numbers)):\n            if abs(numbers[i] - numbers[j]) < threshold:\n                return True\n    return False`,
  task2_chatgpt: `def below_zero(operations):\n    return sum(operations) < 0`,
  task2_claude: `def below_zero(operations):\n    balance = 0\n    for op in operations:\n        balance += op\n        if balance < 0:\n            return True\n    return False`,
  task3_chatgpt: `def sum_product(numbers):\n    total, product = 0, 1\n    for n in numbers:\n        total += n\n        product *= n\n    return total, product`,
  task3_claude: `def sum_product(numbers):\n    total, product = 0, 0\n    for n in numbers:\n        total += n\n        product *= n\n    return total, product`,
};

// ================== Utility helpers ==================
function fmt(v) {
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `(${v.join(", ")})`;
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}
function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}
function cleanCode(text) {
  if (!text) return "";
  const fence = text.match(/```(?:python)?\s*([\s\S]*?)```/i);
  let body = fence ? fence[1].trim() : text.trim();
  body = stripMarkdownEscapes(body);
  body = convertIndentMarkers(body);
  return body;
}

// Some chat UIs render function/variable names with markdown italic escaping
// (e.g. "has\_close\_elements" instead of "has_close_elements") when the text
// is copied from rendered markdown rather than a code block. A backslash
// directly before an underscore is never valid/needed in real Python source,
// so it's safe to always undo this specific escape.
function stripMarkdownEscapes(text) {
  return text.replace(/\\_/g, "_");
}

// Converts lines using the ">"-marker indentation scheme back into real
// 4-space Python indentation. Tolerant of real AI/browser output which often
// adds its own leading whitespace and stray spaces between markers (e.g.
// "  > > for i in ..." or "> > >"), and drops lines that are just marker
// characters with no real code (blank-line artifacts some tools insert
// between statements). A line with no ">" markers at all (e.g. "def ...")
// is emitted at level 0, trimmed.
function convertIndentMarkers(text) {
  // Plain code with real indentation and no ">" markers is left untouched.
  if (!/^\s*[>.]/m.test(text)) return text;
  const lines = text.split("\n");
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    // Leading run of ">" characters possibly separated/surrounded by spaces,
    // anchored at the start of the line (after any real leading whitespace).
    const m = line.match(/^\s*((?:[>.]\s*)+)(.*)$/);
    if (!m) {
      // No markers at all: keep as-is but drop pure real leading indentation
      // so it doesn't collide with our reconstructed levels.
      const trimmed = line.trim();
      if (trimmed === "") continue; // drop blank lines entirely
      out.push(trimmed);
      continue;
    }
    const level = (m[1].match(/[>.]/g) || []).length;
    const content = m[2].trim();
    if (content === "") continue; // drop marker-only / blank artifact lines
    out.push("    ".repeat(level) + content);
  }
  return out.join("\n");
}

function log(msg) {
  const el = document.getElementById("consoleLog");
  el.textContent += "\n" + msg;
  el.scrollTop = el.scrollHeight;
}
function codeId(taskKey, toolKey) { return `code_${taskKey}_${toolKey}`; }
function getCode(taskKey, toolKey) {
  const el = document.getElementById(codeId(taskKey, toolKey));
  return el ? el.value : "";
}
function setCode(taskKey, toolKey, value) {
  const el = document.getElementById(codeId(taskKey, toolKey));
  if (el) el.value = value;
}
function storageKey(taskKey, toolKey) { return `aidemo_${taskKey}_${toolKey}`; }

// ================== Pyodide execution ==================
// Each call runs in its own isolated namespace (via exec(..., ns)) so that
// ChatGPT's and Claude's pasted code never leak into each other, even when
// both define a function with the same name.
async function execFunction(code, funcName, argsExpr) {
  const cleaned = cleanCode(code);
  if (!cleaned) return { ok: false, error: "NO_CODE" };

  const pyDriver = `
import json as __json
__ns = {}
try:
    exec(${JSON.stringify(cleaned)}, __ns)
except Exception as __e:
    __result = {"ok": False, "error": "Code did not run (syntax/import error): " + str(__e)}
else:
    if ${JSON.stringify(funcName)} not in __ns:
        __result = {"ok": False, "error": "Function '${funcName}' not found in pasted code"}
    else:
        try:
            __value = __ns[${JSON.stringify(funcName)}](${argsExpr})
            __result = {"ok": True, "value": __value}
        except Exception as __e:
            __result = {"ok": False, "error": "Runtime error while calling ${funcName}: " + str(__e)}
__json.dumps(__result)
`;

  try {
    const resultJson = window.pyodide.runPython(pyDriver);
    const parsed = JSON.parse(resultJson);
    if (parsed.ok) return { ok: true, value: parsed.value };
    return { ok: false, error: parsed.error };
  } catch (e) {
    return { ok: false, error: "Unexpected error: " + String((e && e.message) || e) };
  }
}

// ================== Rendering: prompts ==================
function renderPromptGrid() {
  const grid = document.getElementById("promptGrid");
  grid.innerHTML = "";
  for (const task of TASKS) {
    const div = document.createElement("div");
    div.className = "prompt-card";
    div.innerHTML = `
      <h4>Task ${task.id}: <code>${task.name}</code></h4>
      <pre class="prompt-box">${escapeHtml(task.prompt)}</pre>
      <button class="btn copy" data-prompt-idx="${task.id}">📋 Copy Prompt</button>
    `;
    grid.appendChild(div);
  }
  grid.querySelectorAll("button[data-prompt-idx]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const task = TASKS.find((t) => t.id === Number(btn.dataset.promptIdx));
      await navigator.clipboard.writeText(task.prompt);
      btn.textContent = "✅ Copied!";
      log(`Copied generation prompt for Task ${task.id} (${task.name}) to clipboard.`);
      setTimeout(() => (btn.textContent = "📋 Copy Prompt"), 1500);
    });
  });
}

// ================== Rendering: paste-back ==================
function renderPasteGrid() {
  const grid = document.getElementById("pasteGrid");
  grid.innerHTML = `
    <div class="paste-toolbar">
      <button id="fillExampleBtn" class="btn reset">Fill Example Data (for testing the UI only)</button>
      <button id="clearAllBtn" class="btn reset">Clear All</button>
    </div>
  `;
  for (const task of TASKS) {
    const div = document.createElement("div");
    div.className = "paste-card";
    div.innerHTML = `
      <h4>Task ${task.id}: <code>${task.name}</code></h4>
      <div class="paste-cols">
        ${TOOLS.map(
          (tool) => `
          <div class="paste-col">
            <label>${tool.label}</label>
            <textarea id="${codeId(task.key, tool.key)}" placeholder="Paste ${tool.label}'s ${task.name}(...) function here..."></textarea>
            <button class="btn fixindent" data-fix-key="${task.key}_${tool.key}">🔧 Fix Indentation</button>
            <div class="indent-editor" id="indentEditor_${task.key}_${tool.key}" style="display:none;"></div>
          </div>`
        ).join("")}
      </div>
    `;
    grid.appendChild(div);
  }

  // wire up "Fix Indentation" helper for each textarea
  for (const task of TASKS) {
    for (const tool of TOOLS) {
      const fixKey = `${task.key}_${tool.key}`;
      const btn = grid.querySelector(`button[data-fix-key="${fixKey}"]`);
      btn.addEventListener("click", () => openIndentEditor(task.key, tool.key));
    }
  }

  // restore + persist
  for (const task of TASKS) {
    for (const tool of TOOLS) {
      const saved = localStorage.getItem(storageKey(task.key, tool.key));
      if (saved) setCode(task.key, tool.key, saved);
      document.getElementById(codeId(task.key, tool.key)).addEventListener("input", (e) => {
        localStorage.setItem(storageKey(task.key, tool.key), e.target.value);
      });
    }
  }

  document.getElementById("fillExampleBtn").addEventListener("click", () => {
    for (const task of TASKS) {
      for (const tool of TOOLS) {
        const v = EXAMPLE_CODE[`${task.key}_${tool.key}`] || "";
        setCode(task.key, tool.key, v);
        localStorage.setItem(storageKey(task.key, tool.key), v);
      }
    }
    log("Filled textareas with the report's example ChatGPT/Claude code (for testing the UI only).");
  });

  document.getElementById("clearAllBtn").addEventListener("click", () => {
    for (const task of TASKS) {
      for (const tool of TOOLS) {
        setCode(task.key, tool.key, "");
        localStorage.removeItem(storageKey(task.key, tool.key));
      }
    }
    log("Cleared all pasted code.");
  });
}

// ================== Indentation-fix helper ==================
// If pasted code lost its leading whitespace (a common copy-paste artifact
// from some chat UIs), this lets the user manually set an indent level
// (in units of 4 spaces) per line, with a best-effort initial guess based on
// trailing colons and dedent keywords, then rewrites the textarea.
const DEDENT_KEYWORDS = /^(return|break|continue|pass)\b/;
const DEDENT_ALIGN_KEYWORDS = /^(else|elif|except|finally)\b/;

function guessIndentLevels(lines) {
  const levels = [];
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") { levels.push(level); continue; }
    if (DEDENT_ALIGN_KEYWORDS.test(line) && level > 0) level -= 1;
    levels.push(level);
    if (line.endsWith(":")) {
      level += 1;
    } else if (DEDENT_KEYWORDS.test(line)) {
      // heuristic: a return/break/continue/pass often ends the current block;
      // the *next* line (if not blank) likely belongs to an outer level.
      // We don't decrement here directly; user can adjust with the stepper.
    }
  }
  return levels;
}

function openIndentEditor(taskKey, toolKey) {
  const containerId = `indentEditor_${taskKey}_${toolKey}`;
  const container = document.getElementById(containerId);
  const isOpen = container.style.display !== "none";
  if (isOpen) { container.style.display = "none"; container.innerHTML = ""; return; }

  const raw = getCode(taskKey, toolKey);
  const lines = raw.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[arr.length - 1] === ""));
  if (lines.length === 0) { log("Nothing to fix — the box is empty."); return; }

  const guessed = guessIndentLevels(lines);

  container.style.display = "block";
  container.innerHTML = `
    <div class="indent-lines">
      ${lines
        .map(
          (line, i) => `
        <div class="indent-line-row">
          <button class="indent-step" data-idx="${i}" data-dir="-1">-</button>
          <span class="indent-level" id="lvl_${taskKey}_${toolKey}_${i}">${guessed[i]}</span>
          <button class="indent-step" data-idx="${i}" data-dir="1">+</button>
          <code class="indent-line-text">${escapeHtml(line.trim())}</code>
        </div>`
        )
        .join("")}
    </div>
    <div class="indent-actions">
      <button class="btn primary indent-apply">Apply Indentation</button>
      <button class="btn reset indent-cancel">Cancel</button>
    </div>
  `;

  const state = guessed.slice();
  container.querySelectorAll(".indent-step").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const dir = Number(btn.dataset.dir);
      state[idx] = Math.max(0, state[idx] + dir);
      document.getElementById(`lvl_${taskKey}_${toolKey}_${idx}`).textContent = state[idx];
    });
  });

  container.querySelector(".indent-apply").addEventListener("click", () => {
    const rebuilt = lines.map((line, i) => "    ".repeat(state[i]) + line.trim()).join("\n");
    setCode(taskKey, toolKey, rebuilt);
    localStorage.setItem(storageKey(taskKey, toolKey), rebuilt);
    container.style.display = "none";
    container.innerHTML = "";
    log(`Applied manual indentation for ${toolKey}/${taskKey}.`);
  });

  container.querySelector(".indent-cancel").addEventListener("click", () => {
    container.style.display = "none";
    container.innerHTML = "";
  });
}

// ================== Rendering: test results ==================
function renderTestTable(rows) {
  const tbody = document.getElementById("testTableBody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    let verdict;
    const chatgptOk = r.chatgpt.ok, claudeOk = r.claude.ok;
    if (chatgptOk && claudeOk) verdict = "Both correct";
    else if (!chatgptOk && !claudeOk) verdict = "Both wrong";
    else if (!chatgptOk) verdict = "ChatGPT error";
    else verdict = "Claude error";

    tr.innerHTML = `
      <td>${r.task}</td>
      <td><code>${r.input}</code></td>
      <td>${fmt(r.expected)}</td>
      <td class="${chatgptOk ? "pass" : "fail"}">${escapeHtml(r.chatgpt.display)}</td>
      <td class="${claudeOk ? "pass" : "fail"}">${escapeHtml(r.claude.display)}</td>
      <td>${verdict}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderScoreSummary(chatgptPass, chatgptTotal, claudePass, claudeTotal) {
  const summary = document.getElementById("scoreSummary");
  summary.innerHTML =
    `ChatGPT: <span class="${chatgptPass === chatgptTotal ? "ok" : "fail"}">${chatgptPass}/${chatgptTotal}</span> &nbsp;|&nbsp; ` +
    `Claude: <span class="${claudePass === claudeTotal ? "ok" : "fail"}">${claudePass}/${claudeTotal}</span>`;
}

// ================== Rendering: repair cards ==================
function renderRepairCards(failures) {
  const grid = document.getElementById("repairGrid");
  grid.innerHTML = "";
  if (failures.length === 0) {
    grid.innerHTML = `<p class="hint">No failing cases to repair (either everything passed, or no code has been pasted yet).</p>`;
    return;
  }
  for (const f of failures) {
    const promptText =
`Your previous Python solution failed this test:
Input: ${f.input}
Expected output: ${fmt(f.expected)}
Actual output: ${fmt(f.actual)}
Identify the cause, keep the same function signature (${f.task.name}), and return the complete corrected function with the smallest necessary change.
${MARKER_INSTRUCTIONS}`;

    const div = document.createElement("div");
    div.className = "repair-card";
    div.innerHTML = `
      <h4>${f.tool.label} — Task ${f.task.id} (${f.task.name})</h4>
      <div class="status">Failed on input <code>${f.input}</code> → expected ${fmt(f.expected)}, got ${fmt(f.actual)}</div>
      <pre class="prompt-box">${escapeHtml(promptText)}</pre>
      <button class="btn repair" data-copy-repair>📋 Copy Repair Prompt</button>
    `;
    div.querySelector("button").addEventListener("click", async () => {
      await navigator.clipboard.writeText(promptText);
      log(`Copied repair prompt for ${f.tool.label} / Task ${f.task.id}. Paste it into ${f.tool.label}, then paste the corrected function back into Step 2 and re-run.`);
    });
    grid.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ================== Run all tests ==================
async function runAllTests() {
  if (!window.pyodide) {
    log("Python engine still loading, please wait...");
    return;
  }
  const rows = [];
  const failures = [];
  let chatgptPass = 0, chatgptTotal = 0, claudePass = 0, claudeTotal = 0;

  for (const task of TASKS) {
    for (const test of task.tests) {
      const rowResult = { task: task.id, input: test.label, expected: test.expected };
      for (const tool of TOOLS) {
        const code = getCode(task.key, tool.key);
        const res = await execFunction(code, task.name, test.argsExpr);
        let display, ok;
        if (!res.ok) {
          display = res.error === "NO_CODE" ? "No code pasted" : res.error.slice(0, 160);
          if (/indented block|IndentationError|unexpected indent/i.test(res.error)) {
            display += " ⚠ Tip: use the 'Copy' button on the tool's code block (not manual text selection) to preserve indentation.";
            log(`DEBUG raw pasted code for ${tool.label}/${task.name}:\n${JSON.stringify(code)}`);
          }
          ok = false;
        } else {
          display = fmt(res.value);
          ok = eq(res.value, test.expected);
        }
        rowResult[tool.key] = { display, ok };

        if (tool.key === "chatgpt") { chatgptTotal++; if (ok) chatgptPass++; }
        else { claudeTotal++; if (ok) claudePass++; }

        if (!ok && res.ok) {
          failures.push({ task, tool, input: test.label, expected: test.expected, actual: res.value });
        }
      }
      rows.push(rowResult);
    }
  }

  renderTestTable(rows);
  renderScoreSummary(chatgptPass, chatgptTotal, claudePass, claudeTotal);
  renderRepairCards(failures);
  log(`Ran real Python tests. ChatGPT ${chatgptPass}/${chatgptTotal}, Claude ${claudePass}/${claudeTotal}.`);
}

// ================== Boot ==================
async function boot() {
  renderPromptGrid();
  renderPasteGrid();

  const runBtn = document.getElementById("runTestsBtn");
  runBtn.addEventListener("click", runAllTests);

  try {
    window.pyodide = await loadPyodide();
    log("Python engine ready. Paste real ChatGPT/Claude code above, then click Run Tests.");
    runBtn.disabled = false;
    runBtn.textContent = "▶ Run Tests";
  } catch (e) {
    log("Failed to load Python engine: " + e.message);
  }
}

boot();