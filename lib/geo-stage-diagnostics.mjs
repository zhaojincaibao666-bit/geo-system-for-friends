import { classifyBrowserVisibilityAnswer, extractCompetitorCandidates } from "./core.mjs";

const BRAND_RELATIONS = new Set(["confirmed", "probable"]);
const CAPTURE_OBSERVED = new Set(["success", "empty"]);
const asText = (value) => String(value ?? "").trim();
const questionId = (question) => asText(question?.promptId || question?.questionId || question?.job?.question_id);

function citationsFor(question) {
  if (Array.isArray(question?.browserCitations) && question.browserCitations.length) return question.browserCitations;
  if (Array.isArray(question?.citations)) return question.citations;
  if (Array.isArray(question?.job?.citations)) return question.job.citations;
  return [];
}

function captureStatus(question) {
  return question?.citationCaptureStatus || question?.job?.citation_capture_status || "not_available";
}

function citationFacts(question) {
  const citations = citationsFor(question);
  const status = captureStatus(question);
  const brandCitations = citations.filter((citation) => BRAND_RELATIONS.has(citation.brandRelatedCitation));
  return {
    citations,
    brandCitations,
    captureStatus: status,
    captureObserved: CAPTURE_OBSERVED.has(status),
    citationCaptureReliable: status === "success" || status === "empty",
  };
}

function judgementFor(question, brand) {
  const rawAnswer = asText(question?.rawAnswer);
  const stored = question?.mentionResult || {};
  const judged = rawAnswer ? classifyBrowserVisibilityAnswer(rawAnswer, brand) : {};
  return {
    rawAnswer,
    brandMentioned: stored.brandMentioned !== undefined ? Boolean(stored.brandMentioned) : Boolean(judged.brandMentioned),
    recommendation: question?.recommendationResult?.recommendation || judged.recommendation || "none",
    position: question?.recommendationResult?.position ?? judged.position ?? null,
    validAnswer: judged.hasValidCompanyAnswer !== false,
    competitors: brand ? extractCompetitorCandidates(rawAnswer, brand) : [],
  };
}

function fact(type, detail, value = true) {
  return { type, detail, value };
}

function result({ question, diagnosisType, confidence, evidenceLevel, facts, limitations = [], summary }) {
  return {
    questionId: questionId(question),
    diagnosisType,
    confidence,
    evidenceLevel,
    evidence: { facts, limitations },
    summary,
  };
}

/**
 * Diagnose the likely stage of visibility loss for one final answer.
 * This is an evidence-labelled inference layer; it never changes GEO scores.
 */
export function diagnosePromptStages(question, { brand = null } = {}) {
  const judgement = judgementFor(question, brand);
  const citation = citationFacts(question);
  const facts = [];
  if (judgement.brandMentioned) facts.push(fact("final_answer", "最终回答中观察到品牌实体"));
  else facts.push(fact("final_answer", "最终回答中未观察到品牌实体", false));
  facts.push(fact("citation_capture", `Citation 采集状态为 ${citation.captureStatus}`, citation.captureObserved));
  if (citation.brandCitations.length) facts.push(fact("brand_source", `观察到 ${citation.brandCitations.length} 个品牌相关引用来源`, citation.brandCitations.map((item) => item.domain || item.url || item.title).filter(Boolean)));
  if (judgement.competitors.length) facts.push(fact("competitor_candidates", `最终回答中观察到 ${judgement.competitors.length} 个竞争企业候选`, judgement.competitors));
  if (judgement.position !== null) facts.push(fact("recommendation_position", `品牌推荐位置为 ${judgement.position}`, judgement.position));

  // A failed or unavailable citation capture cannot prove that no source was
  // present. Fail closed instead of calling it retrieval loss.
  if (!judgement.brandMentioned && citation.brandCitations.length) {
    return result({
      question,
      diagnosisType: "generation_selection_loss",
      confidence: citation.brandCitations.some((item) => item.brandRelatedCitation === "confirmed") ? "medium" : "low",
      evidenceLevel: "inference",
      facts,
      limitations: ["Citation/来源存在只能证明品牌信源被观察到，不能证明完整候选集；这是生成阶段选择损失的推断。"],
      summary: "来源中出现品牌信号，但最终回答没有保留品牌。",
    });
  }

  if (judgement.brandMentioned && citation.brandCitations.length && !["first", "top3"].includes(judgement.recommendation)) {
    const explicitPosition = Number.isFinite(Number(judgement.position));
    return result({
      question,
      diagnosisType: "ranking_competitiveness",
      confidence: explicitPosition ? "high" : "medium",
      evidenceLevel: "inference",
      facts,
      limitations: ["最终推荐排序可能受题目措辞、模型策略和展示截断影响；没有把位置推断成完整市场排名。"],
      summary: explicitPosition ? `品牌被提及且有来源，但推荐位置为 ${judgement.position}，未进入优先推荐。` : "品牌被提及且有来源，但未观察到优先推荐。",
    });
  }

  if (!judgement.brandMentioned && citation.citationCaptureReliable && !citation.brandCitations.length && judgement.competitors.length) {
    const confidence = judgement.competitors.length >= 2 ? "medium" : "low";
    return result({
      question,
      diagnosisType: "likely_retrieval_or_candidate_loss",
      confidence,
      evidenceLevel: "inference",
      facts,
      limitations: ["没有完整候选集，不能确认召回失败；竞争企业仍出现只是候选流失的支持信号。"],
      summary: "最终回答没有品牌来源或品牌提及，但仍出现竞争企业候选，倾向召回/候选集损失。",
    });
  }

  return result({
    question,
    diagnosisType: "unknown",
    confidence: "low",
    evidenceLevel: "unknown",
    facts,
    limitations: [citation.captureReliable ? "当前证据不足以区分召回、排序或生成选择问题。" : "Citation 未可靠采集，无法判断来源/候选是否存在。"],
    summary: "证据不足，无法确认发生在哪个阶段。",
  });
}

export function buildPromptStageDiagnostics(run, { brand = null } = {}) {
  const items = (run?.questions || []).filter((question) => question.status === "success").map((question) => diagnosePromptStages(question, { brand }));
  const types = ["likely_retrieval_or_candidate_loss", "ranking_competitiveness", "generation_selection_loss", "unknown"];
  return {
    schemaVersion: 1,
    items,
    counts: Object.fromEntries(types.map((type) => [type, items.filter((item) => item.diagnosisType === type).length])),
    confidenceCounts: Object.fromEntries(["high", "medium", "low"].map((level) => [level, items.filter((item) => item.confidence === level).length])),
    inferenceCount: items.filter((item) => item.evidenceLevel === "inference").length,
    factCount: items.filter((item) => item.evidenceLevel === "fact").length,
    unknownCount: items.filter((item) => item.evidenceLevel === "unknown").length,
  };
}
