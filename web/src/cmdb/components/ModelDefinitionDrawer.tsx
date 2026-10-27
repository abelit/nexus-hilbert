import { useEffect, useMemo, useState } from 'react';
import { Copy, Download } from 'lucide-react';

import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/locale';
import { cn } from '@/lib/cn';
import { downloadJSON } from '@/lib/download';

import { describeError } from '../api/http';
import {
  getCIType,
  listAttributeGroups,
  listTriggers,
  listTypeAttributes,
  listUniqueConstraints,
  relationChildren,
  relationParents,
  type Trigger,
  type UniqueConstraint,
} from '../api/citype';
import { buildModelDefinition, type ModelDefinition } from '../lib/model-definition';
import { Drawer } from './Drawer';

// The read-only model-definition snapshot.
//
// IT FETCHES ON OPEN, not on the model page's mount. The definition spans every
// tab, including relations that Base UI has not mounted yet, and the page's own
// group loader deliberately swallows a failure. A download must not turn that
// failure into "this model has no form sections", so the snapshot uses its own
// reads and its own error.
//
// THE TWO RULE SECTIONS ARE ADMIN-ONLY on the server. A non-admin export omits
// them as null and records why; it never calls the gated endpoints.

type RuleSnapshot = {
  constraints: UniqueConstraint[] | null;
  triggers: Trigger[] | null;
};

type Feedback = {
  tone: 'success' | 'error';
  message: string;
};

function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'model';
}

export function ModelDefinitionDrawer({
  ref_,
  modelLabel,
  isAdmin,
  onClose,
}: {
  ref_: string;
  modelLabel: string;
  isAdmin: boolean;
  onClose(): void;
}) {
  const { tr } = useI18n();
  const [definition, setDefinition] = useState<ModelDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    setDefinition(null);
    setFeedback(null);

    const rules: Promise<RuleSnapshot> = isAdmin
      ? Promise.all([listUniqueConstraints(ref_), listTriggers(ref_)]).then(([constraints, triggers]) => ({
          constraints,
          triggers,
        }))
      : Promise.resolve({ constraints: null, triggers: null });

    void Promise.all([
      getCIType(ref_),
      listTypeAttributes(ref_),
      listAttributeGroups(ref_, false),
      relationChildren(ref_),
      relationParents(ref_),
      rules,
    ])
      .then(([model, typeAttributes, groups, children, parents, ruleSnapshot]) => {
        if (!live) return;
        setDefinition(
          buildModelDefinition({
            model,
            attributes: typeAttributes.attributes ?? [],
            groups,
            childRelations: children,
            parentRelations: parents,
            constraints: ruleSnapshot.constraints,
            triggers: ruleSnapshot.triggers,
            isAdmin,
            exportedAt: new Date().toISOString(),
          }),
        );
      })
      .catch((error) => {
        if (live) setErr(describeError(error, tr('无法读取模型定义', 'Could not load the model definition')));
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [isAdmin, ref_, retryKey, tr]);

  const json = useMemo(() => (definition ? JSON.stringify(definition, null, 2) : ''), [definition]);

  const copy = async () => {
    if (!json) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(json);
      setFeedback({ tone: 'success', message: tr('已复制模型定义', 'Model definition copied') });
    } catch {
      setFeedback({
        tone: 'error',
        message: tr('复制失败，请手动选择 JSON 文本', 'Could not copy; select the JSON text manually'),
      });
    }
  };

  const download = () => {
    if (!json) return;
    try {
      const name = safeFilename(definition?.model.name || modelLabel || ref_);
      downloadJSON(`cmdb-model-${name}.json`, json);
      setFeedback({ tone: 'success', message: tr('已开始下载', 'Download started') });
    } catch (error) {
      setFeedback({ tone: 'error', message: describeError(error, tr('下载失败', 'Download failed')) });
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={`${tr('模型定义', 'Model definition')} · ${modelLabel}`}
      description={
        isAdmin
          ? tr(
              '只读 JSON 快照：模型、属性、表单分组、关系、唯一约束和触发器。不包含实例数据；Webhook 授权不会返回。',
              'A read-only JSON snapshot of the model, attributes, form sections, relations, uniqueness rules and triggers. It contains no instance data; webhook authorization is not returned.',
            )
          : tr(
              '只读 JSON 快照：模型、属性、表单分组和关系。唯一约束与触发器仅管理员可读取，JSON 中会标记为省略。',
              'A read-only JSON snapshot of the model, attributes, form sections and relations. Uniqueness rules and triggers are admin-only and are marked as omitted in the JSON.',
            )
      }
      footer={
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2">
          <span
            role={feedback ? (feedback.tone === 'error' ? 'alert' : 'status') : undefined}
            aria-live="polite"
            className={cn(
              'min-w-0 text-[11px]',
              feedback?.tone === 'error'
                ? 'text-red-600 dark:text-red-300'
                : 'text-emerald-600 dark:text-emerald-300',
            )}
          >
            {feedback?.message ?? ''}
          </span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void copy()}
              disabled={!json || loading}
              className="inline-flex items-center gap-1.5"
            >
              <Copy size={12} aria-hidden="true" />
              {tr('复制 JSON', 'Copy JSON')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={download}
              disabled={!json || loading}
              className="inline-flex items-center gap-1.5 font-medium"
            >
              <Download size={12} aria-hidden="true" />
              {tr('下载 JSON', 'Download JSON')}
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center text-xs text-text-muted">
          {tr('加载中…', 'Loading…')}
        </div>
      ) : err ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          <span className="min-w-0 flex-1 break-words">{err}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => setRetryKey((key) => key + 1)}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      ) : (
        <pre
          tabIndex={0}
          aria-label={tr('模型定义 JSON', 'Model definition JSON')}
          className="min-w-0 max-w-full overflow-auto rounded-lg border border-border bg-bg/60 p-3 font-mono text-[11px] leading-relaxed text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          <code>{json}</code>
        </pre>
      )}
    </Drawer>
  );
}
