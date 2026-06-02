import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// CP949/EUC-KR 디코딩 (iconv-lite 없이 Node.js 내장 TextDecoder 사용)
// Node.js 22+ 에서 EUC-KR 지원. CP949는 EUC-KR의 상위집합이나
// 주식 종목명에 사용되는 한글은 EUC-KR로도 충분히 디코딩 가능
function decodeCp949(buffer) {
  try {
    const decoder = new TextDecoder("cp949");
    return decoder.decode(buffer);
  } catch {
    // CP949 미지원 환경 → EUC-KR로 폴백
    try {
      const decoder = new TextDecoder("euc-kr");
      return decoder.decode(buffer);
    } catch {
      // 최종 폴백: 수동 디코딩
      const result = [];
      let i = 0;
      while (i < buffer.length) {
        const byte = buffer[i];
        if (byte <= 0x7f) {
          result.push(String.fromCharCode(byte));
          i++;
        } else {
          const byte2 = buffer[i + 1];
          if (byte2 !== undefined) {
            result.push(String.fromCharCode((byte << 8) | byte2));
            i += 2;
          } else {
            result.push("?");
            i++;
          }
        }
      }
      return result.join("");
    }
  }
}

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

  const content = decodeCp949(fs.readFileSync(filePath));
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