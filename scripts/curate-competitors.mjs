// Explicitly invoked, preview-first cleanup of the saved Doubao company list.
// This identifies names in answers; it does not certify business registration.
import { readFile, copyFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { nameKey, changeCompanies } from "../lib/competitor-model.mjs";

const roots = `目标品牌 简创 皓奇乐 信亿 富升 正奇 华旺 华圣 再昇 中旺 凯琪 亮节 海盛 景元 益康 康达 宏源 奇骏 泽成 贝乐园 诚卓 志森 源康 熙旺 玩乐童话 利轩 星亮 兴德 漫油田里 东芭 鸿鑫 耀鸿 奔航 长信 宏铭 亿润 尤尼可 华丽 哈一代 晟安 逸萌 鸿泰 毛逗 美琳 伟鑫 俊欧 超联 蓝海 钧辉 叁零 傲群 乐童梦 博弘 萌奇奇 爱诚 常娥 童心源 华宇 舒奇 标艺 自然先生 正华 和誉 我扬 新亿 优美 悦动 淘贝贝 小布点 兴源 桐馨语 顺铨 镇泰 富之馀 福盈 宏润 南新 精汇 永裕 美润达 冠宏 宏升 柯仕尼 星图 语心桐 玖捷 景顺 鑫宝达 博宏 诺贝 睿兴 浩远 维赛 艺贝 乐致 远荣 亨润 哇偶 兴美鑫 鼎漫 宝利丰 景宝 欧迈丰 幸福小屋 眠织 骏辉 攸米 盛裕 欣达 雄韬 梓旭 滨发 萌宝 耀辉 乐利 年顺 泽广 品正 沃田 雅琳 卡卡西 品昕 福岛 国鼎 金牛 再森 和孚 搪搪 伟吾 欧瑞 联鑫 浩舟 心海 信捷 亿泽 谷语 鸿顺 科琦 安信 彩铭 恒胜 瑞绒童趣 晓兴 大漂亮 堃鸿 吉物 南森 品一 卓毅 一六八 昱美 永利 鸿达 川禾 合东 福康 丽晶 友趣 百乐 华璨 嘉信 泰旭 亿鸟 云集智汇 妍玺 威斯 星创 多浪 优润 悦润 悦全 迷尼`.split(/\s+/);
const tails = /^(?:玩具|毛绒|工厂|厂|加工|店|定制|制品|制造|科技|智能|实业|文化|传播|发展|产业|动漫|服饰|服装|制衣|礼品|工艺|娃厂|娃衣|玩偶|文创|潮玩|婴儿|婴童|用品|供应链|塑胶|电子|手袋|绒艺|棉花娃娃|棉花娃|公仔|有限责任公司|股份有限公司|有限公司|股份公司|公司|茶山|镇|东莞|市|省|广东|东莞市|官网|平岭路|精细|打样|创意|布绒|毛绒玩具|智能制造)*$/;
const genericTokens = `中大型 中大 中小型 中小 中等 中低端 中端 中高端 中型 小型 小 大 中 全 超 其他 本地 当地 茶山镇 茶山 东莞市 东莞 厚街 石排 虎门 南城 市区 广东 全域 全国 片区 区域 镇区 镇街 镇 厂区 产业带 集群 地域 源头 工厂 玩具厂 加工厂 玩具 加工 厂 厂家 企业 公司 供应商 定制 代工 工贸 一体化 一站式 全链路 全流程 全工序 自有 外资 港资 本土 正规 成熟 上市 规上 标杆 头部 量产 规模化 规模 批量 订单 单 大货 产能 实力 综合 综合型 全能 全能型 通用 优质 优选 首选 主力 备选 补充 额外 推荐 优先 适合 型 类 向 级 性价比 高性价比 价位 价格 务实 灵活 柔性 快反 快速 稳定 快 精品 高端 精细 精细化 高品质 品质 工艺 还原度 强项 专精 专项 专攻 专门 专注 擅长 深耕 细分 特色 特长 小众 定向 配套 文创 潮玩 毛绒 棉花娃娃 棉花娃 娃娃 娃衣 娃圈 二次元 人形 玩偶 人偶 吉祥物 公仔 婴童 礼品 礼赠 活动 文旅 国潮 国风 地方 周边 品牌 原创 IP OEM ODM 企业 电商 出口 外贸 内销 国内 国际 大牌 授权 商超 商务 供应链 安全 合规 标准 高标准 验厂 资质 认证 品控 检测 质检 老牌 资深 老 生产 设计 开发 版型 开版 打样 图纸 图片 原画 草图 三视图 概念稿 形象 服饰 服装 时装 车缝 缝纫 刺绣 绣花 电绣 面料 绒布 布绒 布艺 数码 印花 胶脸 搪胶 塑胶 硅胶 复合 盲盒 多材质 挂件 包挂 钥匙扣 迷你 小件 礼品单 量级 小单 中大单 中小单 试单 试销 新品 新锐 单款 常规 传统 配件 规模化 小而精 沟通 联系 对接 洽谈 合作 筛选 选型 选厂 找厂 挑选 选择 如何 怎么 按 根据 直接 锁定 匹配 区分 看 实操 实用 简单 通用 参考 指南 对照表 对比表 对照 判断 提示 小提示 提醒 要点 关键 重点 硬核 核心 考察 标配 清单 策略 方式 方案 模式 流程 表 区位 小知识 路线 走访 寻访 询盘 询价 话术 模板 提问 实地 线上 核验 核查 核实 核对 避坑 避雷 注意 重要 必 必须 必备 必看 必问 必确认 必核实 必核查 确认 准备 前期 初期 初次 前 后 前的 下单 下单前 前准备 需求 信息 资料 素材 条件 问题 用途 规格 尺寸 数量 预估 预计 是否 需要 可 提供 支持 明确 要求 已有 收取 打样费 合同 写明 报告 版权 保密 知识产权 协议 条款 时间 交期 自己 有 自有 车间 还是 二道 贸易 没有 不是 不要找 不要 不用 额外 寻找 纯 无 来图 来样 来图来样 通用 行业 行情 你 的 了 与 和 或 等 为 于 不如 多 为 到 只 做 有个 提供 出具 效果图 修改 准备资料 主打 主推 高 低 检验 玩具安全 数百家 上千家 千家 家 很多 大量 几家 有上 有 上面 同步 可考虑 一些 这些 还有 结合 优势 能力 经验 实战 项目 赛道 出身 优劣 对比 配合 特殊 全品类 全市 告诉我 补充说明 毛绒公仔 数码印花 大多 外发给 电绣精度 高于 普通 无资质 无专职 版房 成品 成熟 外协 长期 很多玩具厂 十年 二十年 年 一百件 件 多为 人形玩偶 不稳定 小批量 验厂型 产能不如 本地知名 茶京路 一带 服装加工 报价 保密与 智造 服装厂 包装 功能 游戏 动漫 开团 海外 商超 核查清单 检测报告 还原 具体 主要 专职 两种 三类 重点说明 衍生品 自主 原创设计 需要找 选择上面 提供图片 起订 收费 低起订 推荐理由 来图来样定制`.split(/\s+/).sort((a,b)=>b.length-a.length);
const genericPattern = new RegExp(`^(?:${[...new Set(genericTokens)].join("|")}|[\\d+])+?$`, "i");
const exactGeneric = new Set(["中大型", "补充", "首选", "小提示", "规格", "用途", "素材", "重要提醒", "海盛之外补充"]);

export function identityRoot(name) {
  let value = String(name).normalize("NFKC").replace(/📍.*$|【.*$/g, "").trim();
  // Literal wrappers found in saved answers, not arbitrary fuzzy spelling fixes.
  value = value.replace(/^(?:补充\s*\(|可同步看|一些|我们是|中外玩具网来到)/, "");
  if (/kinwin|jolly|\/|乐威|YuHong/i.test(value)) return null;
  if (/^(?:简创|玩乐童话|皓奇乐|凯琪|正奇|哈一代|漫博).*\(/.test(value)) value = value.slice(value.indexOf("(") + 1);
  value = nameKey(value).replace(/^(?:广东省?)?(?:东莞市?)?(?:茶山镇?)?/, "");
  if (/^漫博潮玩$/.test(value)) return "文博";
  for (const root of [...roots, "文博"].sort((a,b)=>b.length-a.length)) {
    if (value.startsWith(root) && tails.test(value.slice(root.length))) return root;
  }
  return null;
}

export function classifyName(name) {
  const root = identityRoot(name);
  if (root) return { kind: "company", root, reason: "名称主体一致，差别为地区、行业后缀或已知简称" };
  const key = nameKey(name);
  if (exactGeneric.has(name) || genericPattern.test(key)) return { kind: "exclude", reason: "描述工厂类型、地区、采购建议或产品要求，不是具体公司名称" };
  // Full company names can be confirmed as answer entities without asserting registry verification.
  if (/公司/.test(name)) return { kind: "company", root: null, reason: "名称中出现“公司”，按规则直接列为公司；未核验工商登记" };
  return { kind: "pending", reason: "名称或简称对应关系仍不明确" };
}

export function planCuration(snapshot, decisions = []) {
  const companies = [...snapshot.confirmed, ...snapshot.pending, ...snapshot.excluded];
  const db = { companies: structuredClone(companies), decisions: [], revision: snapshot.revision, reports: [] };
  // Never undo a manual rejection, restoration or split on a later run.
  const protectedKeys = new Set(decisions.filter(d => ["exclude", "restore", "split"].includes(d.action)).flatMap(d => d.before.flatMap(c => c.aliases.map(nameKey))));
  const protectedCompany = c => c.status === "excluded" || c.aliases.some(a => protectedKeys.has(nameKey(a)));
  const actions = [], groups = new Map();
  const apply = (input, reason) => { actions.push({ ...input, reason }); changeCompanies(db, input); };
  const exclude = db.companies.filter(c => c.status === "pending" && !protectedCompany(c) && c.aliases.every(a => classifyName(a).kind === "exclude"));
  if (exclude.length) apply({ action: "exclude", ids: exclude.map(c => c.id) }, "排除明显的非公司描述");
  for (const c of db.companies) {
    if (protectedCompany(c)) continue;
    const keys = [...new Set(c.aliases.map(identityRoot).filter(Boolean))];
    if (keys.length !== 1) continue;
    const root = keys[0];
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  }
  for (const [root, group] of groups) {
    if (group.length < 2) continue;
    // Preserve the user's primary confirmed record whenever available.
    group.sort((a,b) => Number(b.own) - Number(a.own) || Number(b.status === "confirmed") - Number(a.status === "confirmed") || Number(/公司$/.test(b.name)) - Number(/公司$/.test(a.name)) || b.mentions-a.mentions);
    apply({ action: "merge", ids: group.slice(1).map(c => c.id), targetId: group[0].id }, `合并 ${root} 的简称、全称与地区写法`);
  }
  const confirm = db.companies.filter(c => c.status === "pending" && !protectedCompany(c) && c.aliases.some(a => classifyName(a).kind === "company"));
  if (confirm.length) apply({ action: "confirm", ids: confirm.map(c => c.id) }, "确认回答中明确的公司名称");
  return { actions, companies: db.companies, stats: { beforePending: snapshot.pending.length, excludedNames: exclude.length, mergedNames: actions.filter(a => a.action === "merge").reduce((n,a) => n+a.ids.length,0), confirmedCompanies: confirm.length, remainingPending: db.companies.filter(c => c.status === "pending").length } };
}

async function main() {
  const base = "http://127.0.0.1:4318";
  const api = async (path, body) => {
    const response = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || response.status); return data;
  };
  const disk = JSON.parse(await readFile("data/competitors.json", "utf8"));
  const diskOnly = process.argv.includes("--disk");
  const snapshot = diskOnly
    ? { revision: disk.revision, confirmed: disk.companies.filter(c => c.status === "confirmed"), pending: disk.companies.filter(c => c.status === "pending"), excluded: disk.companies.filter(c => c.status === "excluded") }
    : await api("/api/competitors");
  if (!diskOnly && snapshot.revision !== disk.revision) throw new Error("名单刚发生变化，请重新预览。");
  const plan = planCuration(snapshot, disk.decisions);
  console.log(JSON.stringify(plan.stats));
  if (!process.argv.includes("--apply")) {
    if (process.argv.includes("--groups")) console.log(JSON.stringify(plan.actions.map(a => ({ action: a.action, reason: a.reason, target: plan.companies.find(c => c.id === a.targetId)?.name, names: a.ids.map(id => [...snapshot.pending,...snapshot.confirmed].find(c => c.id === id)?.name) })), null, 2));
    else console.log(JSON.stringify(plan.companies.filter(c => c.status === "pending").map(c => [c.name,c.mentions]), null, 2));
    return;
  }
  await mkdir("data/backups", { recursive: true });
  const backup = resolve(`data/backups/competitors-before-curation-${Date.now()}.json`);
  await copyFile("data/competitors.json", backup);
  console.log(`Backup: ${backup}`);
  if (process.argv.includes("--file-apply")) {
    // The app may be running an older in-memory service. Save atomically, then restart it
    // before any further list operation so its stale memory cannot overwrite this file.
    for (const action of plan.actions) changeCompanies(disk, action);
    disk.updatedAt = new Date().toISOString();
    const temporary = `${resolve("data/competitors.json")}.tmp`;
    await writeFile(temporary, JSON.stringify(disk), "utf8");
    await rename(temporary, resolve("data/competitors.json"));
    console.log(`已直接保存 ${plan.actions.length} 项名单整理操作；请重启系统后再操作名单。`);
  } else {
    const saved = await api("/api/competitors/decisions/batch", { actions: plan.actions });
    console.log(`已一次性保存 ${saved.applied} 项名单整理操作。`);
  }
  if (diskOnly) console.log(JSON.stringify({ final: { confirmed: disk.companies.filter(c => c.status === "confirmed").length, pending: disk.companies.filter(c => c.status === "pending").length, excluded: disk.companies.filter(c => c.status === "excluded").length } }));
  else {
    const final = await api("/api/competitors");
    console.log(JSON.stringify({ final: { confirmed: final.confirmed.length, pending: final.pending.length, excluded: final.excluded.length }, answers: final.totalAnswers, runs: final.totalRuns }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
