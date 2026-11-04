// convert.ts — file conversion, run in-process.
//
// There is no conversion service anywhere in the fleet, so this is not a proxy:
// the container carries pandoc, imagemagick and ffmpeg (declared in build.json
// docker.native_build.apt) and convert.* shells out to whichever one owns the
// target format.
//
// The converter is chosen from the output extension, not from user input, and
// arguments are passed as an argv array — never through a shell — so a filename
// cannot smuggle in a command.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

type Json = Record<string, any>;

// ponytail: extension → tool. Covers the formats these three binaries own;
// extend the table when a format actually comes up.
const DOC = new Set(["md", "html", "docx", "odt", "rst", "tex", "epub", "pdf", "txt"]);
const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "tiff", "bmp", "avif", "ico"]);
const AV = new Set(["mp3", "wav", "flac", "ogg", "m4a", "mp4", "webm", "mkv", "mov", "gif"]);

const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export function toolFor(from: string, to: string): "pandoc" | "convert" | "ffmpeg" | null {
  // Image→image before A/V, since gif is claimed by both tables.
  if (IMG.has(from) && IMG.has(to)) return "convert";
  if (AV.has(from) || AV.has(to)) return "ffmpeg";
  if (DOC.has(from) && DOC.has(to)) return "pandoc";
  if (IMG.has(from) && to === "pdf") return "convert";
  return null;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) resolve({ ok: false, err: String(stderr || error).slice(0, 2000) });
      else resolve({ ok: true });
    });
  });
}

export async function convertCall(op: string, params: Json): Promise<Json> {
  if (op === "formats") {
    return {
      documents: { tool: "pandoc", formats: [...DOC].sort() },
      images: { tool: "imagemagick", formats: [...IMG].sort() },
      audio_video: { tool: "ffmpeg", formats: [...AV].sort() },
      note: "convert.run takes params.content (base64 or text), params.from, params.to.",
    };
  }
  if (op !== "run") return { error: `unknown convert op: ${op}` };

  const from = String(params.from ?? "").replace(/^\./, "").toLowerCase();
  const to = String(params.to ?? "").replace(/^\./, "").toLowerCase();
  if (!from || !to) return { error: "convert.run needs params.from and params.to" };
  if (params.content === undefined) return { error: "convert.run needs params.content" };

  // Extensions land in a shell-free argv, but they also become filenames — keep
  // them to a strict charset so nothing escapes the temp directory.
  if (!/^[a-z0-9]{1,8}$/.test(from) || !/^[a-z0-9]{1,8}$/.test(to)) {
    return { error: "from/to must be short alphanumeric extensions" };
  }

  const tool = toolFor(from, to);
  if (!tool) return { error: `no converter for ${from} → ${to}; call convert.formats for what is supported` };

  const input = params.base64 !== false && typeof params.content === "string" && params.encoding !== "text"
    ? Buffer.from(String(params.content), "base64")
    : Buffer.from(String(params.content), "utf-8");

  if (input.length > MAX_BYTES) return { error: `input is ${input.length} bytes, limit is ${MAX_BYTES}` };

  const dir = await mkdtemp(join(tmpdir(), "drive-convert-"));
  const inFile = join(dir, `in.${from}`);
  const outFile = join(dir, `out.${to}`);
  try {
    await writeFile(inFile, input);
    const argv =
      tool === "pandoc" ? [inFile, "-o", outFile]
      : tool === "convert" ? [inFile, outFile]
      : ["-y", "-i", inFile, outFile];

    const r = await run(tool, argv);
    if (!r.ok) return { error: `${tool} failed`, detail: r.err };

    const out = await readFile(outFile);
    const textual = extname(outFile) === ".txt" || DOC.has(to) && !["pdf", "epub", "docx", "odt"].includes(to);
    return {
      from, to, tool, bytes: out.length,
      ...(textual ? { content: out.toString("utf-8") } : { base64: out.toString("base64") }),
    };
  } catch (e) {
    return { error: String(e) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
