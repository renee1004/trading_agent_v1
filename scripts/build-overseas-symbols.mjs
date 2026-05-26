import fs from "fs";
import path from "path";
import iconv from "iconv-lite";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SOURCES = [
  { file: "NASMST.COD", excd: "NAS", exchangeName: "나스닥" },
  { file: "AMSMST.COD", excd: "AMS", exchangeName: "아멕스" },
  { file: "NYSMST.COD", excd: "NYS", exchangeName: "뉴욕" },
];

const inputDir = path.join(ROOT, "data", "kis-overseas");
const outputPath = path.join(ROOT, "data", "overseas-symbols.json");

const symbols = {};

for (const source of SOURCES) {
  const filePath = path.join(inputDir, source.file);

  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] missing file: ${filePath}`);
    continue;
  }

  const content = iconv.decode(fs.readFileSync(filePath), "cp949");
  const lines = content.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const parts = line.split("\t");

    const country = parts[0] ?? "";
    const marketCode = parts[1] ?? "";
    const excd = parts[2] ?? source.excd;
    const marketName = parts[3] ?? source.exchangeName;
    const symbol = parts[4] ?? "";
    const kisCode = parts[5] ?? "";
    const koreanName = parts[6] ?? "";
    const englishName = parts[7] ?? "";
    const securityType = parts[8] ?? "";
    const currency = parts[9] ?? "USD";

    if (!symbol || !excd) continue;

    symbols[symbol.toUpperCase()] = {
      symbol: symbol.toUpperCase(),
      excd,
      kisCode,
      country,
      marketCode,
      marketName,
      exchangeName: source.exchangeName,
      koreanName,
      englishName,
      securityType,
      currency,
    };
  }
}

const list = Object.values(symbols).sort((a, b) =>
  a.symbol.localeCompare(b.symbol)
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(list, null, 2), "utf8");

console.log(`[OK] wrote ${outputPath}`);
console.log(`[OK] symbols: ${list.length}`);