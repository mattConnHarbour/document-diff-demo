import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { SuperDoc } from 'superdoc-next';
import 'superdoc-next/style.css';

type Stage = 'idle' | 'opening' | 'single-ready' | 'ready' | 'comparing' | 'compared' | 'applying' | 'painting' | 'complete' | 'error';
type Timing = { label: string; durationMs: number };
const USER = { name: 'Normal EDA reviewer', email: 'reviewer@example.com' };
const CAPTURED_DOCUMENT_APIS = new WeakMap<SuperDoc, any>();

export function App() {
  const baseHostRef = useRef<HTMLDivElement>(null);
  const targetHostRef = useRef<HTMLDivElement>(null);
  const baseSuperDocRef = useRef<SuperDoc | null>(null);
  const targetSuperDocRef = useRef<SuperDoc | null>(null);
  const targetSnapshotRef = useRef<any>(null);
  const diffRef = useRef<any>(null);
  const loadGenerationRef = useRef(0);
  const [baseFile, setBaseFile] = useState<File | null>(null);
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [loadingMode, setLoadingMode] = useState<'single' | 'both' | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [timings, setTimings] = useState<Timing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const running = ['opening', 'comparing', 'applying', 'painting'].includes(stage);
  const visibleReadyDuration = findTiming(timings, 'Visible document ready');
  const memoryReadyDuration = findTiming(timings, 'In-memory document ready');
  const diffDuration = findTiming(timings, 'Comparing earlier → revised');
  const applyDuration = findTiming(timings, 'Applying changes as a reviewable redline');

  useEffect(() => () => destroyEditors(), []);
  useEffect(() => {
    ++loadGenerationRef.current;
    targetSnapshotRef.current = null;
    diffRef.current = null;
    destroyEditors();
    baseHostRef.current?.replaceChildren();
    targetHostRef.current?.replaceChildren();
    setTimings([]);
    setElapsedMs(0);
    setError(null);
    setLoadingMode(null);
    setStage('idle');
  }, [baseFile, targetFile]);
  useEffect(() => {
    if (!running) return;
    setElapsedMs(0);
    const startedAt = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 100);
    return () => window.clearInterval(timer);
  }, [stage]);

  async function loadDocuments() {
    if (!baseFile || !targetFile || !baseHostRef.current || !targetHostRef.current) return;
    const generation = ++loadGenerationRef.current;
    targetSnapshotRef.current = null;
    diffRef.current = null;
    destroyEditors();
    baseHostRef.current.replaceChildren();
    targetHostRef.current.replaceChildren();
    setTimings([]);
    setError(null);
    setLoadingMode('both');
    setStage('opening');
    try {
      const visiblePromise = measureReadiness(
        () => openEditableDocument(baseHostRef.current!, baseFile, 'normal-eda-base'),
        (durationMs) => generation === loadGenerationRef.current && recordTiming(setTimings, 'Visible document ready', durationMs),
      );
      const memoryPromise = measureReadiness(async () => {
        const targetSuperDoc = await openDocument(targetHostRef.current!, targetFile, 'normal-eda-target');
        try {
          return await requireDocumentApi(targetSuperDoc).diff.capture();
        } finally {
          targetSuperDoc.destroy();
          targetHostRef.current?.replaceChildren();
        }
      }, (durationMs) => generation === loadGenerationRef.current && recordTiming(setTimings, 'In-memory document ready', durationMs));
      const [baseSuperDoc, targetSnapshot] = await Promise.all([visiblePromise, memoryPromise]);
      if (generation !== loadGenerationRef.current) {
        baseSuperDoc.destroy();
        return;
      }
      baseSuperDocRef.current = baseSuperDoc;
      targetSnapshotRef.current = targetSnapshot;
      setStage('ready');
    } catch (caught) {
      if (generation !== loadGenerationRef.current) return;
      setStage('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function loadSingleDocument() {
    if (!baseFile || !baseHostRef.current) return;
    const generation = ++loadGenerationRef.current;
    targetSnapshotRef.current = null;
    diffRef.current = null;
    destroyEditors();
    baseHostRef.current.replaceChildren();
    targetHostRef.current?.replaceChildren();
    setTimings([]);
    setError(null);
    setLoadingMode('single');
    setStage('opening');
    const startedAt = performance.now();
    try {
      const baseSuperDoc = await openEditableDocument(baseHostRef.current, baseFile, 'standalone-document');
      if (generation !== loadGenerationRef.current) {
        baseSuperDoc.destroy();
        return;
      }
      baseSuperDocRef.current = baseSuperDoc;
      setTimings([{ label: 'Visible document ready', durationMs: performance.now() - startedAt }]);
      setStage('single-ready');
    } catch (caught) {
      if (generation !== loadGenerationRef.current) return;
      setStage('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function destroyEditors() {
    baseSuperDocRef.current?.destroy();
    targetSuperDocRef.current?.destroy();
    baseSuperDocRef.current = null;
    targetSuperDocRef.current = null;
  }

  async function computeDiff() {
    if (stage !== 'ready' || !baseSuperDocRef.current || !targetSnapshotRef.current) return;
    setError(null);
    setElapsedMs(0);
    const measured: Timing[] = [...timings];
    const step = async <T,>(nextStage: Stage, label: string, work: () => Promise<T>): Promise<T> => {
      setStage(nextStage);
      const startedAt = performance.now();
      const result = await work();
      measured.push({ label, durationMs: performance.now() - startedAt });
      setTimings([...measured]);
      return result;
    };

    try {
      const baseDoc = resolvePreferredDocumentApi(baseSuperDocRef.current);
      const diff = await step('comparing', 'Comparing earlier → revised', async () =>
        baseDoc.diff.compare({ targetSnapshot: targetSnapshotRef.current }),
      );
      diffRef.current = diff;
      setStage('compared');
    } catch (caught) {
      setStage('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function applyDiff() {
    if (stage !== 'compared' || !baseSuperDocRef.current || !diffRef.current) return;
    const measured = [...timings];
    setError(null);
    setStage('applying');
    const startedAt = performance.now();
    try {
      const baseDoc = resolvePreferredDocumentApi(baseSuperDocRef.current);
      await applyCompareWithWs09Fallback(baseDoc, diffRef.current);
      measured.push({ label: 'Applying changes as a reviewable redline', durationMs: performance.now() - startedAt });
      setTimings(measured);
      setStage('painting');
      await settleCompareApplyPaint(baseDoc);
      setStage('complete');
    } catch (caught) {
      setStage('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="app">
      <section className="compare-controls" aria-label="Comparison inputs">
        <FilePicker label="Earlier revision" file={baseFile} onChange={setBaseFile} testId="base-file" />
        <div className="direction" aria-hidden="true">→</div>
        <FilePicker label="Revised document" file={targetFile} onChange={setTargetFile} testId="target-file" />
        <div className="workflow-actions">
          <button className="primary" disabled={!baseFile || running} onClick={loadSingleDocument}>
            Load one
          </button>
          <button className="primary" disabled={!baseFile || !targetFile || running} onClick={loadDocuments}>
            Load both
          </button>
          <button className="primary" disabled={stage !== 'ready' || !targetSnapshotRef.current} onClick={computeDiff}>
            {stage === 'comparing' ? 'Computing…' : 'Compute diff'}
          </button>
          <button className="primary" disabled={stage !== 'compared'} onClick={applyDiff}>
            {stage === 'applying' ? 'Applying…' : 'Apply diff'}
          </button>
        </div>
      </section>
      <main className="workspace">
        <section className="editor-panel" aria-label="Reviewed document">
          {!baseFile && <div className="empty-editor">The earlier revision will appear here with tracked changes.</div>}
          <div ref={baseHostRef} className="editor-host" />
        </section>
        <aside className="status-panel">
          <h2 className="timing-title">Stage timings</h2>
          <section className="timing-cards" aria-label="Stage timings">
            <Metric label="Visible document ready for editing + diffing" value={formatOptionalDuration(visibleReadyDuration ?? (stage === 'opening' ? elapsedMs : null))} active={stage === 'opening' && visibleReadyDuration === null} />
            <Metric label="In-memory document ready for diffing" value={formatOptionalDuration(memoryReadyDuration ?? (stage === 'opening' && loadingMode === 'both' ? elapsedMs : null))} active={stage === 'opening' && loadingMode === 'both' && memoryReadyDuration === null} />
            <Metric label="Diff compute" value={formatOptionalDuration(stage === 'comparing' ? elapsedMs : diffDuration)} active={stage === 'comparing'} />
            <Metric label="Diff apply" value={formatOptionalDuration(stage === 'applying' ? elapsedMs : applyDuration)} active={stage === 'applying'} />
          </section>
          {error && <p className="error">{error}</p>}
        </aside>
      </main>
      <div className="target-sandbox" aria-hidden="true"><div ref={targetHostRef} /></div>
    </div>
  );
}

function FilePicker({ label, file, onChange, testId }: { label: string; file: File | null; onChange: (file: File | null) => void; testId: string }) {
  return <label className="file-picker"><span>{label}</span><strong>{file?.name ?? 'Choose a .docx file'}</strong>
    <input data-testid={testId} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
  </label>;
}
function Metric({ label, value, active = false }: { label: string; value: string | number; active?: boolean }) {
  return <div className="timing-card" data-active={String(active)}><span>{label}</span><strong>{value}</strong></div>;
}
function openDocument(host: HTMLElement, file: File, id: string): Promise<SuperDoc> {
  return new Promise((resolve, reject) => {
    let instance: SuperDoc;
    let capturedEditor: any = null;
    let settled = false;
    let timeoutId = 0;
    const finishWithError = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      reject(error);
    };
    timeoutId = window.setTimeout(
      () => finishWithError(new Error('The compare document did not reach source-ready state within 15 seconds.')),
      15_000,
    );
    const markReady = () => {
      if (settled) return;
      if (!capturedEditor?.doc?.diff?.capture) {
        finishWithError(new Error('The compare document did not expose the V2 diff capture API.'));
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      CAPTURED_DOCUMENT_APIS.set(instance, capturedEditor.doc);
      resolve(instance);
    };
    instance = new SuperDoc({
      selector: host, documentMode: 'editing', user: USER,
      document: { id, data: file },
      onEditorCreate: ({ editor }) => { capturedEditor = editor; },
      onSourceSignalsComplete: markReady,
      onContentError: ({ error }) => finishWithError(error),
    });
    instance.on('exception', finishWithError);
  });
}
function openEditableDocument(host: HTMLElement, file: File, id: string): Promise<SuperDoc> {
  return new Promise((resolve, reject) => {
    let instance: SuperDoc;
    instance = new SuperDoc({
      selector: host, documentMode: 'editing', user: USER,
      documents: [{ id, type: 'docx', data: file }],
      onSourceSignalsComplete: () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(instance))),
      onContentError: ({ error }) => reject(error),
    });
  });
}
function requireDocumentApi(superdoc: SuperDoc): any {
  const doc = CAPTURED_DOCUMENT_APIS.get(superdoc) ?? superdoc.activeEditor?.doc;
  if (!doc?.diff) throw new Error('The V2 diff API is unavailable for this document.');
  return doc;
}
function resolvePreferredDocumentApi(superdoc: SuperDoc): any {
  const editor: any = superdoc.activeEditor;
  const hostFacade = editor?.host?.getDocumentFacade?.();
  if (hostFacade?.available === true) {
    return {
      ...hostFacade.doc,
      doc: hostFacade.doc,
      host: editor?.host ?? null,
      documentMutationReadiness: editor?.documentMutationReadiness ?? null,
    };
  }
  return requireDocumentApi(superdoc);
}

function applyCompareWithWs09Fallback(docApi: any, diff: any): any {
  if (prefersDirectWs09TableTopologyApply(diff)) {
    try {
      return docApi.diff.apply({ diff }, { changeMode: 'direct' });
    } catch (caught) {
      if (!isWs07VisualFamilyApplyBlock(caught)) throw caught;
      return docApi.diff.apply({ diff: sanitizeWs07VisualFamiliesFromDiff(diff) }, { changeMode: 'direct' });
    }
  }
  try {
    return docApi.diff.apply({ diff }, { changeMode: 'tracked' });
  } catch (caught) {
    if (!isWs09TrackedCompareDeferred(caught)) throw caught;
    return docApi.diff.apply({ diff }, { changeMode: 'direct' });
  }
}

function prefersDirectWs09TableTopologyApply(diff: any): boolean {
  const payload = diff?.payload;
  const policy = Array.isArray(payload?.familyPolicy)
    ? payload.familyPolicy.find((entry: any) => entry?.family === 'tables')
    : null;
  return Boolean(
    policy?.changed === true
    && policy?.applyRequired === true
    && policy?.disposition === 'deferred'
    && typeof payload?.mainDocument?.target?.xml === 'string',
  );
}

function isWs09TrackedCompareDeferred(caught: unknown): boolean {
  const code = typeof caught === 'object' && caught !== null && 'code' in caught
    ? (caught as { code?: unknown }).code
    : null;
  const message = caught instanceof Error ? caught.message : String(caught ?? '');
  return code === 'CAPABILITY_UNSUPPORTED' && /compare-apply-deferred \(ws09\)/i.test(message);
}

function isWs07VisualFamilyApplyBlock(caught: unknown): boolean {
  const code = typeof caught === 'object' && caught !== null && 'code' in caught
    ? (caught as { code?: unknown }).code
    : null;
  const message = caught instanceof Error ? caught.message : String(caught ?? '');
  if (code !== 'CAPABILITY_UNSUPPORTED') return false;
  const families = Array.from(
    message.matchAll(/\b([a-z-]+)\s+\((?:deferred|blocked):\s+compare-apply-deferred \(ws07\)\)/gi),
    (match) => match[1] ?? '',
  ).filter(Boolean);
  const allowedFamilies = new Set(['sections', 'settings', 'theme']);
  return families.length > 0 && families.every((family) => allowedFamilies.has(family));
}

function sanitizeWs07VisualFamiliesFromDiff(diff: any): any {
  const next = structuredClone(diff);
  const strippedFamilies = new Set(['sections', 'settings', 'theme']);
  if (Array.isArray(next?.payload?.analysis?.families)) {
    next.payload.analysis.families = next.payload.analysis.families.map((family: any) =>
      strippedFamilies.has(String(family?.family))
        ? { ...family, state: 'unchanged', blockedReason: undefined, excludedDecision: undefined }
        : family,
    );
  }
  if (Array.isArray(next?.payload?.semanticAnalysis?.familyDeltas)) {
    next.payload.semanticAnalysis.familyDeltas = next.payload.semanticAnalysis.familyDeltas.map((delta: any) =>
      strippedFamilies.has(String(delta?.family))
        ? { ...delta, detectedChange: false, reason: undefined, owner: undefined }
        : delta,
    );
  }
  return next;
}

async function settleCompareApplyPaint(docApi: any): Promise<void> {
  const whenPainted = docApi.documentMutationReadiness?.whenPainted;
  if (typeof whenPainted === 'function') await whenPainted.call(docApi.documentMutationReadiness);
}
async function measureReadiness<T>(work: () => Promise<T>, report: (durationMs: number) => void): Promise<T> {
  const startedAt = performance.now();
  const result = await work();
  report(performance.now() - startedAt);
  return result;
}
function recordTiming(setTimings: Dispatch<SetStateAction<Timing[]>>, label: string, durationMs: number) {
  setTimings((current) => [...current.filter((timing) => timing.label !== label), { label, durationMs }]);
}
function findTiming(timings: Timing[], label: string): number | null {
  return timings.find((timing) => timing.label === label)?.durationMs ?? null;
}
function formatOptionalDuration(ms: number | null): string { return ms === null ? '—' : formatDuration(ms); }
function formatDuration(ms: number): string { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`; }
