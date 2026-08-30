/** Codec badge on track rows: what the file is, in the terms that matter.
 *
 *  Lossless = codec only — bitrate says nothing about quality there.
 *  Lossy = codec + measured average bitrate. MP3 additionally carries the
 *  CBR/VBR verdict read from its frame headers by the scanner: a bare
 *  number means "this number the whole way through"; "~" means an average
 *  of a varying stream. Other lossy codecs have no readable mode, so they
 *  always show the "~" average. */

const NAMES: Record<string, string> = {
  flac: "FLAC",
  wav: "WAV",
  alac: "ALAC",
  aiff: "AIFF",
  ape: "APE",
  wavpack: "WV",
  mpeg: "MP3",
  mp3: "MP3",
  aac: "AAC",
  mp4: "M4A",
  vorbis: "OGG",
  opus: "OPUS",
  speex: "SPEEX",
  mpc: "MPC",
};

const LOSSLESS = new Set(["flac", "wav", "alac", "aiff", "ape", "wavpack"]);

export function codecBadgeText(
  codec: string | null | undefined,
  bitrate: number | null | undefined,
  mode: string | null | undefined,
): string | null {
  if (!codec) return null;
  const name = NAMES[codec] ?? codec.toUpperCase();
  if (LOSSLESS.has(codec) || bitrate == null || bitrate <= 0) return name;
  if (codec === "mpeg" || codec === "mp3") {
    if (mode === "cbr") return `${name} CBR ${bitrate}`;
    if (mode === "vbr") return `${name} VBR ~${bitrate}`;
    return `${name} ${bitrate}`;
  }
  return `${name} ~${bitrate}`;
}

export function CodecBadge({
  codec,
  bitrate,
  mode,
}: {
  codec: string | null | undefined;
  bitrate: number | null | undefined;
  mode: string | null | undefined;
}) {
  const text = codecBadgeText(codec, bitrate, mode);
  if (!text) return null;
  const title = text.includes("~")
    ? "Average bitrate of a variable stream (kbps)"
    : text.includes("CBR")
      ? "Constant bitrate (kbps)"
      : "Audio format";
  return (
    <span
      className="shrink-0 rounded bg-foreground/15 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-foreground/80"
      title={title}
    >
      {text}
    </span>
  );
}
