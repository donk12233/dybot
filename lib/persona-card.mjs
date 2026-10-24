// 默认角色卡：正文在同目录 persona-default.md（避免模板字符串里的反引号问题）。
// 想改默认值就改那个 .md；config.json 里的 persona.character 才是实际生效的那份。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CHARACTER = fs.readFileSync(path.join(here, "persona-default.md"), "utf8").trim();