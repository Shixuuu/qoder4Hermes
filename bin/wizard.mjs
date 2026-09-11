/**
 * Hermes-style interactive chrome: magenta box, ◆ headers, radio lists.
 */
const tty = process.stdout.isTTY && process.stdin.isTTY;

const ansi = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const ui = {
  mag: (s) => (tty ? `\x1b[38;2;196;132;252m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[38;2;56;189;248m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[38;2;250;204;21m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[38;2;52;211;153m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[38;2;251;113;133m${s}\x1b[0m` : s),
  dim: (s) => (tty ? `\x1b[38;2;161;161;170m${s}\x1b[0m` : s),
  fg: (s) => (tty ? `\x1b[38;2;228;228;231m${s}\x1b[0m` : s),
  bold: (s) => ansi("1", s),
};

const WIDTH = 57;

function padBox(text) {
  const raw = text.replace(/\x1b\[[0-9;]*m/g, "");
  const room = WIDTH - 2;
  if (raw.length >= room) return text.slice(0, room);
  return text + " ".repeat(room - raw.length);
}

export function printBanner(title, ...body) {
  const top = "┌" + "─".repeat(WIDTH - 2) + "┐";
  const mid = "├" + "─".repeat(WIDTH - 2) + "┤";
  const bot = "└" + "─".repeat(WIDTH - 2) + "┘";
  console.log("");
  console.log(ui.mag(top));
  console.log(ui.mag("│" + padBox(`  ◆  ${title}`) + "│"));
  if (body.length) {
    console.log(ui.mag(mid));
    for (const line of body) console.log(ui.mag("│" + padBox(`  ${line}`) + "│"));
  }
  console.log(ui.mag(bot));
  console.log("");
}

export function printHeader(title) {
  console.log("");
  console.log(ui.bold(ui.cyan(`◆ ${title}`)));
  console.log("");
}

export function printInfo(...lines) {
  for (const line of lines) {
    if (line == null) console.log("");
    else console.log(`  ${ui.dim(line)}`);
  }
}

export function printOk(msg) {
  console.log(`  ${ui.green("✔")}  ${msg}`);
}

export function printBad(msg) {
  console.log(`  ${ui.red("✖")}  ${msg}`);
}

export function printWarn(msg) {
  console.log(`  ${ui.yellow("!")}  ${msg}`);
}

function readRawChar() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const restore = () => {
      if (stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause();
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (s) => {
      stdin.removeListener("data", onData);
      restore();
      resolve(s);
    };
    stdin.on("data", onData);
  });
}

export async function readLine({ hidden = false, prompt = "" } = {}) {
  if (prompt) process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => resolve(buf.trim()));
    });
  }
  const stdin = process.stdin;
  if (hidden && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let buf = "";
  return new Promise((resolve) => {
    const onData = (s) => {
      if (s === "\u0003") {
        console.log("");
        process.exit(130);
      }
      if (s === "\n" || s === "\r") {
        stdin.removeListener("data", onData);
        if (hidden && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(buf.trim());
        return;
      }
      if (s === "\u007f" || s === "\b") {
        buf = buf.slice(0, -1);
        return;
      }
      if (s.startsWith("\x1b")) return;
      buf += s;
      if (!hidden) process.stdout.write(s);
    };
    stdin.on("data", onData);
  });
}

function renderRadio(title, items, selected) {
  const lines = [
    ui.yellow(`  ${title}`),
    ui.dim("  ↑/↓ move · Enter select · or type a number"),
    "",
  ];
  items.forEach((item, i) => {
    const on = i === selected;
    const arrow = on ? ui.green("→") : " ";
    const radio = on ? ui.green("(●)") : ui.dim("(○)");
    const label = on ? ui.fg(item.label) : item.label;
    const hint = item.hint ? `  ${ui.dim(item.hint)}` : "";
    lines.push(`  ${arrow} ${radio}  ${String(i + 1).padStart(2)}. ${label}${hint}`);
  });
  lines.push("");
  console.log(lines.join("\n"));
  return lines.length;
}

export async function radioChoice(title, items, defaultIndex = 0) {
  let selected = Math.max(0, Math.min(defaultIndex, items.length - 1));
  if (!tty) {
    console.log(ui.yellow(`\n  ${title}`));
    console.log(ui.dim("  Select by number, Enter to confirm.\n"));
    items.forEach((item, i) => {
      const mark = i === selected ? ui.green("(●)") : "(○)";
      console.log(`  ${mark} ${i + 1}. ${item.label}${item.hint ? "  " + ui.dim(item.hint) : ""}`);
    });
    console.log("");
    const ans = await readLine({
      prompt: ui.dim(`  Choice [default ${selected + 1}]: `),
    });
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    return selected;
  }

  let height = renderRadio(title, items, selected);
  while (true) {
    const key = await readRawChar();
    if (key === "\u0003") {
      console.log("");
      process.exit(130);
    }
    if (key === "\x1b[A" || key === "k") {
      selected = (selected + items.length - 1) % items.length;
    } else if (key === "\x1b[B" || key === "j") {
      selected = (selected + 1) % items.length;
    } else if (key === "\r" || key === "\n" || key === " ") {
      return selected;
    } else {
      const num = Number(key);
      if (Number.isInteger(num) && num >= 1 && num <= items.length) return num - 1;
      continue;
    }
    process.stdout.write(`\x1b[${height}A`);
    height = renderRadio(title, items, selected);
  }
}

export async function promptYesNo(question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const ans = await readLine({
    prompt: ui.yellow(`${question} [${hint}]: `),
  });
  if (!ans) return defaultYes;
  return /^y/i.test(ans);
}
