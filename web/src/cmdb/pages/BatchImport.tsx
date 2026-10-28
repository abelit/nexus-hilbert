import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  Download,
  FileSpreadsheet,
  FileUp,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/store/me';

import {
  listCITypes,
  listTypeAttributes,
  relationParents as listRelationParents,
  type CIType,
  type RelatedType,
  type TypeAttribute,
} from '../api/citype';
import { describeError } from '../api/http';
import {
  commitImport,
  previewImport,
  type ImportPreview,
  type ImportRequest,
  type ImportResult,
} from '../api/import';
import { ResultDialog } from '../components/import/ResultDialog';
import { TemplateDialog } from '../components/import/TemplateDialog';
import { useToast } from '../components/Toast';
import { downloadBlob } from '../lib/export';
import { attributeHeader, parentTemplates } from '../lib/import-template';
import {
  buildRowsBlob,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  parseSheetFile,
  SheetError,
  type ParsedSheet,
} from '../lib/sheet';

// 批量导入 — the cantor workflow rebuilt on the port's server-side import.
//
// CANTOR'S IMPORT WAS THE BROWSER'S. It parsed the sheet with ExcelJS and then
// posted one instance per request, six at a time, so a five-thousand-row file
// was five thousand transactions and a failure in the middle left the rows
// before it written. This page keeps the three-step shape operators know —
// choose a model, upload a template, preview and import — but the preview and
// the write are one server call each, and the write is one transaction.
//
// THE TEMPLATE IS STILL BUILT HERE, because reading and writing xlsx belongs to
// the browser and the server takes `{headers, rows}`. The template dialog is
// where the model's attributes and parent relations become that header row.

type Policy = 'reject' | 'replace';

const MAX_PREVIEW_ROWS = 200;

export default function BatchImportPage() {
  const { tr } = useI18n();
  const toast = useToast();
  const { canMutate } = usePermissions();

  const [models, setModels] = useState<CIType[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsErr, setModelsErr] = useState<string | null>(null);

  const [modelRef, setModelRef] = useState('');
  const [attributes, setAttributes] = useState<TypeAttribute[]>([]);
  const [parents, setParents] = useState<RelatedType[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [parentsErr, setParentsErr] = useState<string | null>(null);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [policy, setPolicy] = useState<Policy>('replace');

  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [result, setResult] = useState<ImportResult | null>(null);
  const [resultOpen, setResultOpen] = useState(false);

  const modelSeq = useRef(0);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!canMutate) {
      setModelsLoading(false);
      return;
    }
    let live = true;
    setModelsLoading(true);
    setModelsErr(null);
    void listCITypes()
      .then((got) => {
        if (live) setModels(got);
      })
      .catch((error) => {
        if (live) setModelsErr(describeError(error, tr('无法读取模型', 'Could not load the models')));
      })
      .finally(() => {
        if (live) setModelsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [canMutate, tr]);

  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: String(model.id),
        label: model.alias || model.name,
      })),
    [models],
  );

  const selectedModel = useMemo(
    () => models.find((model) => String(model.id) === modelRef),
    [models, modelRef],
  );
  const selectedParents = useMemo(() => parentTemplates(parents), [parents]);
  const uniqueAttribute = useMemo(
    () => attributes.find((attribute) => attribute.name === selectedModel?.unique_key),
    [attributes, selectedModel?.unique_key],
  );

  // A model switch invalidates everything downstream: its attributes are a
  // different set, so a preview of the previous model's sheet is meaningless.
  useEffect(() => {
    if (!modelRef) {
      setAttributes([]);
      setParents([]);
      setModelErr(null);
      setParentsErr(null);
      setModelLoading(false);
      return;
    }
    const seq = (modelSeq.current += 1);
    setModelLoading(true);
    setModelErr(null);
    setParentsErr(null);
    void Promise.all([
      listTypeAttributes(modelRef),
      listRelationParents(modelRef).catch((error) => {
        if (modelSeq.current === seq) {
          setParentsErr(
            describeError(error, tr('无法读取模型的父级关系', 'Could not load the model’s parent relations')),
          );
        }
        return [] as RelatedType[];
      }),
    ])
      .then(([gotAttributes, gotParents]) => {
        if (modelSeq.current !== seq) return;
        setAttributes(gotAttributes.attributes ?? []);
        setParents(gotParents);
      })
      .catch((error) => {
        if (modelSeq.current === seq) {
          setAttributes([]);
          setParents([]);
          setModelErr(describeError(error, tr('无法读取模型属性', 'Could not load the model’s attributes')));
        }
      })
      .finally(() => {
        if (modelSeq.current === seq) setModelLoading(false);
      });
  }, [modelRef, tr]);

  const resetSheet = useCallback(() => {
    previewSeq.current += 1;
    setSheet(null);
    setFileName('');
    setFileSize(0);
    setSheetErr(null);
    setParsing(false);
    setPreview(null);
    setPreviewing(false);
    setPreviewErr(null);
    setCommitErr(null);
    setCommitting(false);
    setResult(null);
    setResultOpen(false);
  }, []);

  const chooseModel = useCallback(
    (next: string) => {
      if (next === modelRef) return;
      modelSeq.current += 1;
      setModelRef(next);
      setAttributes([]);
      setParents([]);
      setModelErr(null);
      setParentsErr(null);
      resetSheet();
    },
    [modelRef, resetSheet],
  );

  const requestFor = useCallback(
    (parsed: ParsedSheet, nextPolicy: Policy = policy): ImportRequest => ({
      ci_type: modelRef,
      headers: parsed.headers,
      rows: parsed.rows,
      exist_policy: nextPolicy,
    }),
    [modelRef, policy],
  );

  const runPreview = useCallback(
    async (parsed: ParsedSheet, nextPolicy: Policy = policy) => {
      if (!modelRef) return;
      const seq = (previewSeq.current += 1);
      setPreviewing(true);
      setPreviewErr(null);
      setCommitErr(null);
      setResult(null);
      setResultOpen(false);
      try {
        const got = await previewImport(requestFor(parsed, nextPolicy));
        if (previewSeq.current === seq) setPreview(got);
      } catch (error) {
        if (previewSeq.current === seq) {
          // A failed preview must not leave a valid-looking older preview that
          // the operator can still commit under the new policy or file.
          setPreview(null);
          setPreviewErr(describeError(error, tr('预览失败', 'Could not preview the sheet')));
        }
      } finally {
        if (previewSeq.current === seq) setPreviewing(false);
      }
    },
    [modelRef, policy, requestFor, tr],
  );

  const chooseFile = useCallback(
    async (file: File | undefined) => {
      if (!file || committing) return;
      if (!modelRef) {
        setSheetErr(tr('先选择模型，再上传表格。', 'Choose a model before uploading a sheet.'));
        return;
      }
      resetSheet();
      setFileName(file.name);
      setFileSize(file.size);
      setParsing(true);
      try {
        const parsed = await parseSheetFile(file);
        setSheet(parsed);
        setParsing(false);
        await runPreview(parsed);
      } catch (error) {
        setParsing(false);
        setSheetErr(
          error instanceof SheetError
            ? error.message
            : describeError(error, tr('无法解析表格', 'Could not parse the sheet')),
        );
      }
    },
    [committing, modelRef, resetSheet, runPreview, tr],
  );

  const changePolicy = useCallback(
    (next: Policy) => {
      setPolicy(next);
      if (sheet) void runPreview(sheet, next);
    },
    [runPreview, sheet],
  );

  const commit = useCallback(async () => {
    if (!sheet || !preview || preview.invalid > 0 || committing || result) return;
    setCommitting(true);
    setCommitErr(null);
    try {
      const got = await commitImport(requestFor(sheet));
      setResult(got);
      setResultOpen(true);
      toast.success(tr(`已导入 ${got.written} 行`, `Imported ${got.written} rows`));
    } catch (error) {
      setCommitErr(describeError(error, tr('导入失败', 'Could not import the sheet')));
    } finally {
      setCommitting(false);
    }
  }, [committing, preview, requestFor, result, sheet, toast, tr]);

  const issueRows = useMemo(() => {
    if (!sheet || !preview) return [];
    return preview.rows
      .filter((row) => !row.ok)
      .map((row) => sheet.rows[row.row - 1] ?? [])
      .filter((row) => row.length > 0);
  }, [preview, sheet]);

  const downloadIssues = useCallback(async () => {
    if (!sheet || issueRows.length === 0) return;
    setExporting(true);
    try {
      const blob = await buildRowsBlob(sheet.headers, issueRows);
      downloadBlob(`${fileBase(selectedModel)}-issues.xlsx`, blob);
    } catch (error) {
      setPreviewErr(describeError(error, tr('无法生成问题行文件', 'Could not build the issue-rows file')));
    } finally {
      setExporting(false);
    }
  }, [issueRows, selectedModel, sheet, tr]);

  const modelReady = Boolean(selectedModel) && !modelLoading && !modelErr;
  const hasResult = Boolean(result);
  const step = hasResult || preview || sheet || parsing || previewing ? 2 : modelReady ? 1 : 0;
  const done = [Boolean(selectedModel), Boolean(sheet) || Boolean(preview), hasResult];

  if (!canMutate) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <PageHeader
          title={tr('批量导入', 'Batch import')}
          subtitle={tr('从 CSV 或 XLSX 一次写入多行资源数据。', 'Write many resource rows from a CSV or XLSX sheet.')}
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <Card>
            <EmptyState
              title={tr('没有导入权限', 'Import is not available to this role')}
              hint={tr(
                '只读账号可以查看资源数据，但不能批量写入。请让管理员或普通用户执行导入。',
                'A viewer can read resources but cannot write them in bulk. Ask an admin or a user to run the import.',
              )}
            />
          </Card>
        </div>
      </div>
    );
  }

  const mapping = [
    ...(preview?.columns ?? []),
    ...(preview?.relations ?? []).map((relation) => ({ ...relation, relation: true as const })),
  ].sort((left, right) => left.index - right.index);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PageHeader
        title={tr('批量导入', 'Batch import')}
        subtitle={tr(
          `上传 CSV 或 XLSX，先预览映射与错误，再一次性写入。最多 ${MAX_IMPORT_ROWS} 行、${MAX_IMPORT_COLUMNS} 列。`,
          `Upload a CSV or XLSX, preview the mapping and errors, then write in one transaction. Up to ${MAX_IMPORT_ROWS} rows and ${MAX_IMPORT_COLUMNS} columns.`,
        )}
        actions={
          <Link
            to="/cmdb/instances"
            className="og-button inline-flex items-center gap-1.5"
            data-size="sm"
            data-variant="outline"
          >
            {tr('返回资源数据', 'Back to resources')}
          </Link>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <StepStrip
            steps={[
              { title: tr('选择模型', 'Choose a model'), hint: tr('决定表头与关系列', 'Sets the headers') },
              { title: tr('上传表格', 'Upload a sheet'), hint: tr('CSV 或 XLSX', 'CSV or XLSX') },
              { title: tr('预览并导入', 'Preview and import'), hint: tr('一次事务写入', 'One transaction') },
            ]}
            current={step}
            done={done}
          />

          <Card>
            <StepHeading
              index={1}
              title={tr('选择模型并下载模板', 'Choose a model and download a template')}
              hint={tr(
                '模板列来自模型属性；模型关系写成 $父模型名.属性，导入时按该值找到父实例。',
                'Template columns come from the model. Relation columns are $parentModelName.attribute and resolve the parent by that value.',
              )}
              done={done[0]}
            />

            {modelsErr && <Alert tone="danger">{modelsErr}</Alert>}

            {modelsLoading ? (
              <p className="py-6 text-center text-xs text-text-muted">{tr('正在读取模型…', 'Loading models…')}</p>
            ) : models.length === 0 ? (
              <EmptyState
                title={tr('还没有可导入的模型', 'No model can be imported yet')}
                hint={tr('先在模型配置中创建模型并绑定属性。', 'Create a model and bind its attributes in model configuration first.')}
              />
            ) : (
              <>
                <div className="mt-4 grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <div>
                    <Label htmlFor="cmdb-import-model">{tr('模型', 'Model')}</Label>
                    <Select
                      id="cmdb-import-model"
                      label={tr('模型', 'Model')}
                      value={modelRef}
                      onValueChange={chooseModel}
                      options={modelOptions}
                      placeholder={tr('选择一个模型', 'Choose a model')}
                      className="mt-1 w-full"
                      disabled={modelLoading}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => setTemplateOpen(true)}
                      disabled={!modelReady || committing}
                      className="inline-flex items-center gap-1.5"
                    >
                      <Download size={12} aria-hidden="true" />
                      {tr('下载模板', 'Download template')}
                    </Button>
                  </div>
                </div>

                {modelErr && <Alert tone="danger">{modelErr}</Alert>}
                {parentsErr && <Alert tone="warning">{parentsErr}</Alert>}

                {selectedModel && !modelLoading && !modelErr && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                    <span className="font-medium text-text">{selectedModel.alias || selectedModel.name}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {tr(
                        `${attributes.length} 个属性，${selectedParents.length} 个父模型关系`,
                        `${attributes.length} attributes, ${selectedParents.length} parent relations`,
                      )}
                    </span>
                    {uniqueAttribute ? (
                      <Chip tone="info">
                        {tr(
                          `标识：${attributeHeader(attributes, uniqueAttribute)}`,
                          `Identifier: ${attributeHeader(attributes, uniqueAttribute)}`,
                        )}
                      </Chip>
                    ) : (
                      <Chip tone="warning">
                        {tr('模型没有唯一标识属性', 'The model has no identifying attribute')}
                      </Chip>
                    )}
                    {selectedParents.length > 0 && (
                      <Chip>
                        {tr(
                          `关系列：${selectedParents.map((parent) => parent.related.type.alias || parent.related.type.name).join('、')}`,
                          `Relations: ${selectedParents.map((parent) => parent.related.type.alias || parent.related.type.name).join(', ')}`,
                        )}
                      </Chip>
                    )}
                  </div>
                )}
              </>
            )}
          </Card>

          <Card>
            <StepHeading
              index={2}
              title={tr('上传表格', 'Upload a sheet')}
              hint={tr(
                '点击或把文件拖到这里。解析在浏览器完成，服务端只接收表头与单元格。',
                'Click or drag a file here. Parsing happens in the browser; the server receives headers and cells.',
              )}
              done={done[1]}
            />

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div>
                <label
                  htmlFor="cmdb-import-file"
                  onDragOver={(event) => {
                    if (!modelReady || committing) return;
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setDragOver(false);
                  }}
                  onDrop={(event: DragEvent<HTMLLabelElement>) => {
                    event.preventDefault();
                    setDragOver(false);
                    if (!modelReady || committing) return;
                    void chooseFile(event.dataTransfer.files[0]);
                  }}
                  className={cn(
                    'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-6 py-10 text-center transition-colors',
                    'hover:border-indigo-500/60 hover:bg-indigo-500/[0.04]',
                    'focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20',
                    dragOver && 'border-indigo-500 bg-indigo-500/[0.06]',
                    (!modelReady || committing) && 'pointer-events-none cursor-not-allowed opacity-55',
                  )}
                >
                  <FileUp size={28} className="text-text-faint" aria-hidden="true" />
                  <p className="text-sm text-text">
                    {modelReady
                      ? tr('点击或拖拽文件至此上传', 'Click or drag a file here')
                      : tr('先选择模型，再上传表格', 'Choose a model before uploading')}
                  </p>
                  <p className="text-[11px] text-text-muted">
                    {tr(
                      `支持 CSV / XLSX / XLSM；最多 ${MAX_IMPORT_ROWS} 行、${MAX_IMPORT_COLUMNS} 列`,
                      `CSV / XLSX / XLSM; up to ${MAX_IMPORT_ROWS} rows and ${MAX_IMPORT_COLUMNS} columns`,
                    )}
                  </p>
                  <Input
                    id="cmdb-import-file"
                    type="file"
                    accept=".csv,.xlsx,.xlsm"
                    aria-label={tr('上传表格', 'Upload sheet')}
                    className="sr-only"
                    disabled={!modelReady || parsing || committing}
                    onChange={(event) => {
                      void chooseFile(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </label>

                {fileName && (
                  <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[11px]">
                    <FileSpreadsheet size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate" title={fileName}>
                      {fileName}
                    </span>
                    <span className="shrink-0 tabular-nums text-text-faint">{formatBytes(fileSize)}</span>
                    <Button
                      variant="plain"
                      size="sm"
                      type="button"
                      onClick={resetSheet}
                      disabled={committing}
                      aria-label={tr('移除文件', 'Remove file')}
                      title={tr('移除文件', 'Remove file')}
                      className="shrink-0 p-1 text-text-faint hover:text-text"
                    >
                      <X size={12} aria-hidden="true" />
                    </Button>
                  </div>
                )}

                {parsing && (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-muted">
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    {tr('正在解析表格…', 'Parsing the sheet…')}
                  </p>
                )}
                {sheetErr && <Alert tone="danger">{sheetErr}</Alert>}
              </div>

              <ol className="list-decimal space-y-1.5 ps-4 text-[11px] leading-relaxed text-text-muted">
                <li>{tr('先选择模型，下载模板后填写；模板的表头就是导入的列。', 'Choose a model, download the template, then fill it in; its headers are the import columns.')}</li>
                <li>{tr('红色关系列写成 $父模型名.属性（如 $rack.机柜编号），会按该属性的值找到父实例并建立关系。', 'A red relation column is $parentModelName.attribute (such as $rack.rack_code); it finds the parent by that value and creates the edge.')}</li>
                <li>{tr('选择型属性在模板里是下拉框；Excel 限制下拉列表最长 255 个字符。', 'Choice attributes become template dropdowns; Excel limits a list to 255 characters.')}</li>
                <li>{tr('单个文件不要超过 5000 行；坏行会在预览里标出，修正后再导入。', 'Keep one file under 5000 rows; bad rows are marked in the preview and must be fixed before import.')}</li>
              </ol>
            </div>
          </Card>

          <Card>
            <StepHeading
              index={3}
              title={tr('预览并导入', 'Preview and import')}
              hint={tr(
                '服务端按模型校验每一行；只要有一行不能写入，整张表格都不会提交。',
                'The server validates every row against the model; if one row cannot be written, nothing is committed.',
              )}
              done={done[2]}
            />

            {previewing && (
              <p className="mt-4 flex items-center gap-1.5 text-xs text-text-muted" role="status">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                {tr('正在预览…', 'Previewing…')}
              </p>
            )}
            {previewErr && <Alert tone="danger">{previewErr}</Alert>}
            {!preview && !previewing && !previewErr && (
              <EmptyState
                title={tr('还未生成预览', 'No preview yet')}
                hint={tr('在上一步上传表格后，这里显示列映射、每行的问题与导入结果。', 'Upload a sheet above to see the column mapping, per-row issues and the import result here.')}
              />
            )}

            {preview && (
              <div className="mt-4 flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={preview.invalid > 0 ? 'warning' : 'success'}>
                    {tr(`${preview.total} 行`, `${preview.total} rows`)}
                  </Chip>
                  <Chip tone="success">{tr(`可导入 ${preview.valid}`, `${preview.valid} valid`)}</Chip>
                  {preview.invalid > 0 && (
                    <Chip tone="danger">{tr(`有问题 ${preview.invalid}`, `${preview.invalid} invalid`)}</Chip>
                  )}
                  <span className="text-[11px] text-text-muted">
                    {tr(
                      `新建 ${preview.creates} · 更新 ${preview.updates}`,
                      `${preview.creates} create · ${preview.updates} update`,
                    )}
                  </span>

                  <div className="ms-auto flex flex-wrap items-center gap-2">
                    <Select
                      value={policy}
                      onValueChange={(next) => changePolicy(next as Policy)}
                      options={[
                        { value: 'replace', label: tr('已存在时覆盖', 'Replace existing') },
                        { value: 'reject', label: tr('已存在时拒绝', 'Reject existing') },
                      ]}
                      label={tr('已存在时', 'When the instance exists')}
                      className="w-40"
                      disabled={previewing || committing}
                    />
                    {preview.invalid > 0 && issueRows.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => void downloadIssues()}
                        disabled={exporting}
                        className="inline-flex items-center gap-1.5"
                      >
                        {exporting ? (
                          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Download size={12} aria-hidden="true" />
                        )}
                        {tr('下载问题行', 'Download issue rows')}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      onClick={() => void commit()}
                      disabled={preview.invalid > 0 || previewing || committing || hasResult}
                      className="inline-flex items-center gap-1.5"
                    >
                      {committing ? (
                        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Upload size={12} aria-hidden="true" />
                      )}
                      {committing
                        ? tr('导入中…', 'Importing…')
                        : hasResult
                          ? tr('已导入', 'Imported')
                          : tr('导入', 'Import')}
                    </Button>
                  </div>
                </div>

                {preview.invalid > 0 && (
                  <Alert tone="warning">
                    {tr(
                      '有问题的行不会写入；修正后重新上传，或下载问题行修改同一个文件。',
                      'Rows with issues are not written. Fix them and upload again, or download the issue rows and edit that file.',
                    )}
                  </Alert>
                )}
                {commitErr && <Alert tone="danger">{commitErr}</Alert>}
                {result && (
                  <Alert tone="success">
                    {tr(
                      `已导入 ${result.written} 行（新建 ${result.creates}，更新 ${result.updates}）。`,
                      `Imported ${result.written} rows (${result.creates} created, ${result.updates} updated).`,
                    )}
                  </Alert>
                )}

                <div>
                  <h3 className="mb-2 text-xs font-medium text-text">{tr('列映射', 'Column mapping')}</h3>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="og-resource-table w-full min-w-[640px] text-xs">
                      <thead>
                        <tr>
                          <th className="text-start">{tr('表格列', 'Sheet column')}</th>
                          <th className="text-start">{tr('映射到', 'Maps to')}</th>
                          <th className="text-start">{tr('说明', 'Note')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mapping.map((column) => {
                          const relation = 'relation' in column;
                          const matched = column.matched;
                          const alias =
                            relation
                              ? `${column.parent_alias || column.parent_type || ''} · ${column.attr_alias || column.attr || ''}`
                              : column.alias || column.attr || '';
                          return (
                            <tr key={`${relation ? 'r' : 'c'}-${column.index}`}>
                              <td className="max-w-56 truncate font-mono" title={column.header}>
                                {column.header || '—'}
                              </td>
                              <td className="min-w-44">
                                <span className="flex flex-wrap items-center gap-1">
                                  <span title={alias}>{alias || '—'}</span>
                                  {relation ? (
                                    <Chip tone="info">{tr('关系', 'Relation')}</Chip>
                                  ) : column.identifier ? (
                                    <Chip tone="info">{tr('标识', 'Identifier')}</Chip>
                                  ) : null}
                                  {!matched && <Chip tone="warning">{tr('未匹配', 'Unmatched')}</Chip>}
                                  {'ignored' in column && column.ignored && (
                                    <Chip>{tr('只读', 'Read-only')}</Chip>
                                  )}
                                </span>
                              </td>
                              <td className="max-w-72 text-text-muted">
                                <span className="line-clamp-2 break-words" title={column.note}>
                                  {column.note || '—'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-medium text-text">{tr('数据预览', 'Sheet preview')}</h3>
                    {preview.rows.length > MAX_PREVIEW_ROWS && (
                      <span className="text-[11px] text-text-faint">
                        {tr(
                          `只显示前 ${MAX_PREVIEW_ROWS} 行，导入仍会处理全部 ${preview.rows.length} 行。`,
                          `Showing the first ${MAX_PREVIEW_ROWS} rows; the import still handles all ${preview.rows.length}.`,
                        )}
                      </span>
                    )}
                  </div>
                  <div className="max-h-[28rem] overflow-auto rounded-md border border-border">
                    <table className="og-resource-table w-full min-w-[760px] text-xs">
                      <thead className="sticky top-0 z-[1]">
                        <tr>
                          <th className="w-14 text-start">#</th>
                          {sheet?.headers.map((header, index) => (
                            <th key={`${header}-${index}`} className="max-w-48 text-start" title={header}>
                              <span className="block truncate">{header || '—'}</span>
                            </th>
                          ))}
                          <th className="w-48 text-start">{tr('状态', 'Status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.slice(0, MAX_PREVIEW_ROWS).map((row) => {
                          const cells = sheet?.rows[row.row - 1] ?? [];
                          const issues = (row.issues ?? [])
                            .map((issue) => `${issue.column ? `${issue.column}: ` : ''}${issue.message}`)
                            .join('；');
                          return (
                            <tr key={row.row} className={cn(!row.ok && 'bg-red-500/[0.04]')}>
                              <td className="font-mono text-text-faint">{row.sheet_row}</td>
                              {sheet?.headers.map((header, index) => (
                                <td key={`${header}-${index}`} className="max-w-48">
                                  <span className="block truncate" title={String(cells[index] ?? '')}>
                                    {String(cells[index] ?? '') || '—'}
                                  </span>
                                </td>
                              ))}
                              <td className="max-w-48">
                                <span className="flex flex-wrap items-center gap-1">
                                  {row.ok ? (
                                    row.action === 'update' ? (
                                      <Chip tone="info">{tr('更新', 'Update')}</Chip>
                                    ) : (
                                      <Chip tone="success">{tr('新建', 'Create')}</Chip>
                                    )
                                  ) : (
                                    <Chip tone="danger">{tr('问题', 'Issue')}</Chip>
                                  )}
                                  {issues && (
                                    <span
                                      className="line-clamp-2 break-words text-[11px] text-red-500"
                                      title={issues}
                                    >
                                      {issues}
                                    </span>
                                  )}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[11px] text-text-faint">
            <span>
              {tr(
                '导入会按唯一标识新建或更新实例；关系列在同一次事务中写入。',
                'The import creates or updates instances by their identifier; relation columns are written in the same transaction.',
              )}
            </span>
            <Button
              variant="plain"
              size="sm"
              type="button"
              onClick={resetSheet}
              disabled={committing || (!sheet && !fileName && !preview)}
              className="inline-flex items-center gap-1.5 text-text-muted hover:text-text"
            >
              <RotateCcw size={12} aria-hidden="true" />
              {tr('重新开始', 'Start over')}
            </Button>
          </div>
        </div>
      </div>

      {selectedModel && (
        <TemplateDialog
          open={templateOpen}
          onClose={() => setTemplateOpen(false)}
          model={selectedModel}
          attributes={attributes}
          parents={selectedParents}
        />
      )}

      {result && (
        <ResultDialog
          open={resultOpen}
          onClose={() => setResultOpen(false)}
          onAgain={() => {
            setResultOpen(false);
            resetSheet();
          }}
          result={result}
          total={preview?.total ?? sheet?.rows.length ?? result.written}
        />
      )}
    </div>
  );
}

function StepStrip({
  steps,
  current,
  done,
}: {
  steps: Array<{ title: string; hint: string }>;
  current: number;
  done: boolean[];
}) {
  const { tr } = useI18n();
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label={tr('导入步骤', 'Import steps')}>
      {steps.map((step, index) => {
        const isDone = done[index];
        const isActive = index === current;
        return (
          <li key={step.title} className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                isDone
                  ? 'bg-emerald-500 text-white'
                  : isActive
                    ? 'bg-indigo-500 text-white ring-4 ring-indigo-500/15'
                    : 'bg-zinc-800 text-text-muted',
              )}
            >
              {isDone ? <Check size={13} aria-hidden="true" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  'block truncate text-xs',
                  isDone || isActive ? 'font-medium text-text' : 'text-text-muted',
                )}
              >
                {step.title}
              </span>
              <span className="hidden text-[11px] text-text-faint sm:block">{step.hint}</span>
            </span>
            {index < steps.length - 1 && (
              <span
                className={cn('mx-1 hidden h-px w-8 rounded-full sm:block', isDone ? 'bg-emerald-500/60' : 'bg-border')}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepHeading({
  index,
  title,
  hint,
  done,
}: {
  index: number;
  title: string;
  hint: string;
  done: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
          done ? 'bg-emerald-500 text-white' : 'bg-zinc-800 text-text-muted',
        )}
      >
        {done ? <Check size={13} aria-hidden="true" /> : index}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{hint}</p>
      </div>
    </div>
  );
}

function Alert({ tone, children }: { tone: 'danger' | 'warning' | 'success'; children: ReactNode }) {
  const classes =
    tone === 'danger'
      ? 'border-red-500/40 bg-red-500/5 text-red-600 dark:text-red-300'
      : tone === 'warning'
        ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300'
        : 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300';
  return (
    <div role="alert" className={cn('mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs', classes)}>
      {tone === 'success' ? (
        <Check size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      ) : (
        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function fileBase(model: CIType | undefined): string {
  return (model?.alias || model?.name || 'cmdb').replace(/[\\/:*?"<>|]/g, '_');
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
