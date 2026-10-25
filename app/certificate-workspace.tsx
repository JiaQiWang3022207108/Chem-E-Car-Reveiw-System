"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canvasToCertificatePdf,
  canvaCertificateCsv,
  certificateFilename,
  prepareCertificateData,
  renderCertificateCanvas,
  resolveCertificateFontFamily,
  type CertificateField,
} from "./certificate-pdf";

type CertificateTemplate = {
  eventName: string;
  issuerText: string;
  stamp: { configured: boolean; filename: string | null; contentType: string | null; url: string | null };
  complete: boolean;
  updatedAt: string | null;
};

type CertificateTemplateResponse = {
  ok: true;
  competitionYear: string;
  template: CertificateTemplate;
};

type CertificateForm = {
  schoolName: string;
  awardName: string;
  instructorsText: string;
  membersText: string;
  issueMonth: string;
};

type ApiErrorResponse = {
  error?: string | { message?: string };
  message?: string;
};

const emptyForm = (): CertificateForm => ({
  schoolName: "",
  awardName: "",
  instructorsText: "",
  membersText: "",
  issueMonth: currentLocalMonth(),
});

const fieldLabels: Record<CertificateField, string> = {
  competitionYear: "竞赛年份",
  eventName: "赛事名称",
  issuerText: "落款文字",
  schoolName: "学校/参赛队",
  awardName: "奖项名称",
  instructors: "指导教师",
  members: "参赛队员",
  issueMonth: "颁发月份",
};

function currentLocalMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function errorMessage(payload: ApiErrorResponse | null, fallback: string) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error === "object" && payload.error.message) return payload.error.message;
  return payload?.message || fallback;
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as T & ApiErrorResponse | null;
  if (!response.ok || !payload) throw new Error(errorMessage(payload, `请求失败（${response.status}）。`));
  return payload;
}

async function loadStamp(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("公章图片读取失败，请重新保存模板。");
  return createImageBitmap(await response.blob());
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function nameCount(value: string) {
  return value.split(/[\s、，,；;]+/u).map((name) => name.trim()).filter(Boolean).length;
}

export function CertificateWorkspace(): React.JSX.Element {
  const [template, setTemplate] = useState<CertificateTemplate | null>(null);
  const [competitionYear, setCompetitionYear] = useState("");
  const [templateForm, setTemplateForm] = useState({ eventName: "", issuerText: "" });
  const [form, setForm] = useState<CertificateForm>(emptyForm);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(true);
  const [stampLoading, setStampLoading] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  const [fontError, setFontError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [busyAction, setBusyAction] = useState<"template" | "stamp" | "pdf" | null>(null);
  const [previewOverflow, setPreviewOverflow] = useState<CertificateField | null>(null);
  const [loadedStampKey, setLoadedStampKey] = useState("");
  const [downloadAgainVisible, setDownloadAgainVisible] = useState(false);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stampImageRef = useRef<ImageBitmap | null>(null);
  const lastPdfRef = useRef<{ blob: Blob; filename: string } | null>(null);
  const outputGenerationRef = useRef(0);
  const stampInputRef = useRef<HTMLInputElement | null>(null);
  const stampUrl = template?.stamp.url || null;
  const stampKey = stampUrl ? `${stampUrl}:${template?.updatedAt || ""}` : "";

  const refreshTemplate = useCallback(async () => {
    setTemplateLoading(true);
    try {
      const response = await fetch("/api/certificate-template", { cache: "no-store", credentials: "same-origin" });
      const payload = await responseJson<CertificateTemplateResponse>(response);
      setCompetitionYear(payload.competitionYear);
      setTemplate(payload.template);
      setTemplateForm({ eventName: payload.template.eventName, issuerText: payload.template.issuerText });
      setTemplateEditorOpen(!payload.template.complete);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "无法读取证书模板，请稍后重试。");
    } finally {
      setTemplateLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refreshTemplate);
  }, [refreshTemplate]);

  useEffect(() => {
    let cancelled = false;
    void resolveCertificateFontFamily().then(() => {
      if (!cancelled) {
        setFontReady(true);
        setFontError("");
      }
    }).catch((error) => {
      if (!cancelled) {
        setFontReady(false);
        setFontError(error instanceof Error ? error.message : "当前浏览器未准备好中文字体，请刷新页面后重试。");
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const previousStamp = stampImageRef.current;
    stampImageRef.current = null;
    previousStamp?.close();
    let cancelled = false;

    if (!stampUrl) {
      void Promise.resolve().then(() => {
        if (!cancelled) setStampLoading(false);
      });
      return () => { cancelled = true; };
    }

    void Promise.resolve().then(() => {
      if (!cancelled) setStampLoading(true);
    });
    void loadStamp(stampUrl).then((image) => {
      if (cancelled) {
        image.close();
        return;
      }
      stampImageRef.current = image;
      setLoadedStampKey(stampKey);
    }).catch((error) => {
      if (!cancelled) setWorkspaceError(error instanceof Error ? error.message : "公章图片无法读取。");
    }).finally(() => {
      if (!cancelled) setStampLoading(false);
    });

    return () => {
      cancelled = true;
      const activeStamp = stampImageRef.current;
      stampImageRef.current = null;
      activeStamp?.close();
    };
  }, [stampKey, stampUrl]);

  const prepared = useMemo(() => template ? prepareCertificateData({
    competitionYear,
    eventName: template.eventName,
    issuerText: template.issuerText,
    ...form,
  }) : null, [competitionYear, form, template]);

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    if (!prepared?.ok || !stampImageRef.current || !fontReady || loadedStampKey !== stampKey) {
      canvas.width = 1754;
      canvas.height = 1240;
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      setPreviewOverflow(null);
      return;
    }
    try {
      const layout = renderCertificateCanvas(canvas, prepared.data, stampImageRef.current, 1754, 1240);
      setPreviewOverflow(layout.overflowField);
    } catch (error) {
      setPreviewOverflow(null);
      setWorkspaceError(error instanceof Error ? error.message : "证书预览生成失败。");
    }
  }, [fontReady, loadedStampKey, prepared, stampKey]);

  const validationMessage = prepared && !prepared.ok
    ? prepared.errors.map((error) => `${fieldLabels[error.field]}：${error.message}`).join("；")
    : "";
  const warnings = prepared?.warnings || [];
  const downloadBlockedReason = templateLoading
    ? "正在读取证书模板。"
    : !template?.complete
      ? "请先保存赛事名称、落款文字和公章图片。"
      : !/^20\d{2}$/u.test(competitionYear)
        ? "请先到 EDP 审核设置选择有效的四位竞赛年份。"
        : !fontReady
          ? fontError || "当前浏览器未准备好中文字体，请刷新页面后重试。"
          : stampLoading
            ? "正在读取公章图片。"
            : loadedStampKey !== stampKey
              ? "公章图片尚未加载。"
              : validationMessage
                ? validationMessage
                : previewOverflow
                  ? `${fieldLabels[previewOverflow]}内容过长，无法完整放入证书安全区域。`
                  : "";

  function updateForm(field: keyof CertificateForm, value: string) {
    invalidateGeneratedCertificate();
    setWorkspaceError("");
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateTemplateForm(field: "eventName" | "issuerText", value: string) {
    invalidateGeneratedCertificate();
    setWorkspaceError("");
    setTemplateForm((current) => ({ ...current, [field]: value }));
  }

  function invalidateGeneratedCertificate() {
    outputGenerationRef.current += 1;
    lastPdfRef.current = null;
    setDownloadAgainVisible(false);
  }

  function clearCertificateDraft() {
    setForm(emptyForm());
    const canvas = previewCanvasRef.current;
    if (canvas) {
      canvas.width = 1754;
      canvas.height = 1240;
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
    outputGenerationRef.current += 1;
    lastPdfRef.current = null;
    setDownloadAgainVisible(false);
    setPreviewOverflow(null);
    setWorkspaceError("");
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("template");
    setWorkspaceError("");
    try {
      const response = await fetch("/api/certificate-template", {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventName: templateForm.eventName, issuerText: templateForm.issuerText }),
      });
      await responseJson<{ ok: true; template: CertificateTemplate }>(response);
      await refreshTemplate();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "模板保存失败，请稍后重试。");
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadStamp(file: File | null) {
    if (!file) return;
    setWorkspaceError("");
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      setWorkspaceError("公章仅支持 PNG 或 JPEG 图片。");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setWorkspaceError("公章图片必须小于或等于 5 MB。");
      return;
    }
    invalidateGeneratedCertificate();
    setBusyAction("stamp");
    let inspection: ImageBitmap | null = null;
    try {
      inspection = await createImageBitmap(file);
      if (inspection.width < 300 || inspection.height < 300) throw new Error("公章图片宽高均不得小于 300 像素。");
      const body = new FormData();
      body.set("stamp", file);
      const response = await fetch("/api/certificate-template/stamp", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        body,
      });
      await responseJson<{ ok: true; template: CertificateTemplate }>(response);
      if (stampInputRef.current) stampInputRef.current.value = "";
      await refreshTemplate();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "公章上传失败，请稍后重试。");
    } finally {
      inspection?.close();
      setBusyAction(null);
    }
  }

  async function generateCertificate() {
    if (!template || downloadBlockedReason) return;
    const outputGeneration = outputGenerationRef.current;
    setBusyAction("pdf");
    setWorkspaceError("");
    try {
      await resolveCertificateFontFamily();
      const freshPrepared = prepareCertificateData({
        competitionYear,
        eventName: template.eventName,
        issuerText: template.issuerText,
        ...form,
      });
      if (!freshPrepared.ok || !stampImageRef.current) return;
      const canvas = document.createElement("canvas");
      const layout = renderCertificateCanvas(canvas, freshPrepared.data, stampImageRef.current);
      if (layout.overflowField) {
        throw new Error(`${fieldLabels[layout.overflowField]}内容过长，无法完整放入证书安全区域。`);
      }
      const filename = certificateFilename(freshPrepared.data);
      const blob = await canvasToCertificatePdf(canvas);
      if (outputGeneration !== outputGenerationRef.current) return;
      lastPdfRef.current = { blob, filename };
      downloadBlob(blob, filename);
      setDownloadAgainVisible(true);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "证书 PDF 生成失败，请稍后重试。");
    } finally {
      setBusyAction(null);
    }
  }

  function downloadAgain() {
    if (!lastPdfRef.current) return;
    downloadBlob(lastPdfRef.current.blob, lastPdfRef.current.filename);
  }

  function downloadCanvaData() {
    if (!prepared?.ok) {
      setWorkspaceError(validationMessage || "请先完整填写本次证书信息，再导出 Canva 数据。");
      return;
    }
    setWorkspaceError("");
    const filename = certificateFilename(prepared.data).replace(/\.pdf$/u, "-Canva.csv");
    downloadBlob(new Blob([canvaCertificateCsv(prepared.data)], { type: "text/csv;charset=utf-8" }), filename);
  }

  return <section className="certificate-workspace" aria-labelledby="certificate-workspace-title">
    <header className="certificate-workspace-heading">
      <div><span>获奖证书</span><h2 id="certificate-workspace-title">证书模板与本地生成</h2><p>模板设置供授权操作者复用；学校、奖项和人员信息仅用于当前浏览器中的预览与下载。</p></div>
      <div className={`certificate-template-status ${template?.complete ? "ready" : "neutral"}`}>{templateLoading ? "读取中" : template?.complete ? "模板已就绪" : "待完成模板"}</div>
    </header>

    {workspaceError && <p className="certificate-message error" role="alert">{workspaceError}</p>}

    <div className="certificate-workspace-grid">
      <div className="certificate-workspace-controls">
        <section className="certificate-template-card" aria-labelledby="certificate-template-title">
          <div className="certificate-card-heading"><div><span>REUSABLE TEMPLATE</span><h3 id="certificate-template-title">证书模板</h3><p>仅保存赛事名称、落款文字和公章图片。</p></div>{template?.complete && <button className="ghost-action" type="button" onClick={() => setTemplateEditorOpen((open) => !open)}>{templateEditorOpen ? "收起模板" : "编辑模板"}</button>}</div>
          {(templateEditorOpen || !template?.complete) && <form className="certificate-template-form" onSubmit={saveTemplate}>
            <label>赛事名称<input type="text" required maxLength={200} value={templateForm.eventName} onChange={(event) => updateTemplateForm("eventName", event.target.value)} /></label>
            <label>落款文字<textarea required maxLength={200} rows={3} value={templateForm.issuerText} onChange={(event) => updateTemplateForm("issuerText", event.target.value)} /></label>
            <button className="secondary-action" type="submit" disabled={busyAction !== null || templateLoading}>{busyAction === "template" ? "正在保存……" : "保存文字模板"}</button>
          </form>}
          <div className="certificate-stamp-upload">
            <div><strong>公章图片</strong><small>{template?.stamp.configured ? `${template.stamp.filename || "已保存公章"} · PNG/JPEG` : "PNG/JPEG，至少 300 × 300 像素，最大 5 MB"}</small></div>
            {template?.stamp.url && <>
              {/* The authenticated server stamp is intentionally displayed at thumbnail size only. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="certificate-stamp-thumbnail" src={template.stamp.url} alt="已保存公章缩略图" />
            </>}
            <label className="certificate-file-label">选择公章<input ref={stampInputRef} type="file" accept="image/png,image/jpeg" onChange={(event) => void uploadStamp(event.target.files?.[0] || null)} disabled={busyAction !== null} /></label>
            {busyAction === "stamp" && <span className="certificate-upload-status" role="status">正在验证并上传公章……</span>}
          </div>
        </section>

        <section className="certificate-form-card" aria-labelledby="certificate-form-title">
          <div className="certificate-card-heading"><div><span>LOCAL DRAFT</span><h3 id="certificate-form-title">本次证书信息</h3><p>填写内容不会提交到模板接口。</p></div></div>
          <div className="certificate-form-fields">
            <label>竞赛年份<input type="text" readOnly value={competitionYear} placeholder="请先到 EDP 审核设置选择年份" /></label>
            <small>竞赛年份只读，来自 EDP 审核设置；如需修改请前往该设置。</small>
            <label>学校/参赛队<input type="text" value={form.schoolName} onChange={(event) => updateForm("schoolName", event.target.value)} /></label>
            <label>奖项名称<input type="text" value={form.awardName} onChange={(event) => updateForm("awardName", event.target.value)} /></label>
            <label>指导教师<textarea rows={3} value={form.instructorsText} onChange={(event) => updateForm("instructorsText", event.target.value)} placeholder="用顿号、逗号或换行分隔" /></label>
            <span className="certificate-count">已识别 {nameCount(form.instructorsText)} 人，最多 5 人</span>
            <label>参赛队员<textarea rows={4} value={form.membersText} onChange={(event) => updateForm("membersText", event.target.value)} placeholder="用顿号、逗号或换行分隔" /></label>
            <span className="certificate-count">已识别 {nameCount(form.membersText)} 人，最多 15 人</span>
            <label>颁发月份<input type="month" value={form.issueMonth} onChange={(event) => updateForm("issueMonth", event.target.value)} /></label>
          </div>
          {warnings.map((warning) => <p className="certificate-warning" key={warning} role="status">{warning}</p>)}
          {validationMessage && <p className="certificate-validation" role="alert">{validationMessage}</p>}
          <button className="ghost-action certificate-clear-action" type="button" onClick={clearCertificateDraft}>清空本次证书信息</button>
        </section>

        <section className="certificate-canva-card" aria-labelledby="certificate-canva-title">
          <div className="certificate-card-heading"><div><span>CANVA BULK CREATE</span><h3 id="certificate-canva-title">在 Canva 中继续制作</h3><p>先下载当前证书的一行标准数据，再到 Canva“批量创建设计”中导入 CSV。</p></div></div>
          <ol className="certificate-canva-steps"><li>点击“下载 Canva 数据”。</li><li>打开 Canva，选择你的证书模板并导入该 CSV。</li></ol>
          <p className="certificate-canva-privacy">本站不会自动上传姓名或其他证书信息；只有你在 Canva 中主动导入 CSV 时，数据才会离开当前浏览器。</p>
          <div className="certificate-canva-actions">
            <button className="secondary-action" type="button" onClick={downloadCanvaData} disabled={!prepared?.ok || busyAction !== null}>下载 Canva 数据</button>
            <a className="primary-action" href="https://www.canva.com/" target="_blank" rel="noopener noreferrer">打开 Canva<span aria-hidden="true">↗</span></a>
          </div>
        </section>
      </div>

      <section className="certificate-preview-card" aria-labelledby="certificate-preview-title">
        <div className="certificate-card-heading"><div><span>LIVE PREVIEW</span><h3 id="certificate-preview-title">证书预览</h3><p>预览使用 1754 × 1240 画布；PDF 将以全分辨率单页生成。</p></div></div>
        <p>PDF 为栅格化图像，文字不可搜索、不可选中。</p>
        <div className="certificate-canvas-frame"><canvas ref={previewCanvasRef} aria-label="获奖证书预览" /></div>
        {downloadBlockedReason && <p className="certificate-blocker" role="alert">{downloadBlockedReason}</p>}
        <div className="certificate-preview-actions">
          <button className="primary-action" type="button" onClick={() => void generateCertificate()} disabled={Boolean(downloadBlockedReason) || busyAction !== null}>{busyAction === "pdf" ? "正在生成 PDF……" : "生成并下载 PDF"}<span>→</span></button>
          {downloadAgainVisible && <button className="secondary-action" type="button" onClick={downloadAgain}>再次下载</button>}
        </div>
      </section>
    </div>
  </section>;
}

export default CertificateWorkspace;
