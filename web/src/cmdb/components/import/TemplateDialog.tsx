import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui';
import { Checkbox } from '@/components/ui/Checkbox';
import { Label } from '@/components/ui/Label';
import { Modal } from '@/components/Modal';
import { Select } from '@/components/ui/Select';
import { useI18n } from '@/i18n/locale';

import type { CIType, TypeAttribute } from '../../api/citype';
import { downloadBlob } from '../../lib/export';
import {
  attributeHeader,
  importableAttributes,
  relationHeader,
  templateColumns,
  type TemplateParent,
} from '../../lib/import-template';
import { buildTemplateBlob } from '../../lib/sheet';

// The template chooser. Cantor's import began here, and the reason is the
// mapping: the server matches headers against the model, so the sheet the
// operator downloads is the only place the model's spelling is guaranteed to
// agree with their edits.

export function TemplateDialog({
  open,
  onClose,
  model,
  attributes,
  parents,
}: {
  open: boolean;
  onClose(): void;
  model: CIType;
  attributes: TypeAttribute[];
  parents: TemplateParent[];
}) {
  const { tr } = useI18n();
  const writable = useMemo(() => importableAttributes(attributes), [attributes]);
  const unique = useMemo(
    () => attributes.find((attribute) => attribute.name === model.unique_key),
    [attributes, model.unique_key],
  );
  const allIDs = useMemo(
    () => writable.map((attribute) => attribute.id),
    [writable],
  );

  const [selectedAttrIDs, setSelectedAttrIDs] = useState<number[]>([]);
  const [selectedParentIDs, setSelectedParentIDs] = useState<number[]>([]);
  const [parentAttrIDs, setParentAttrIDs] = useState<Record<number, number>>({});
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selections belong to one open of the dialog: a model switch must not carry
  // the previous model's attribute ids into the next template.
  useEffect(() => {
    if (!open) return;
    setSelectedAttrIDs(allIDs);
    setSelectedParentIDs([]);
    setParentAttrIDs(
      Object.fromEntries(
        parents
          .filter((parent) => parent.defaultAttrID != null)
          .map((parent) => [parent.related.ctr_id, parent.defaultAttrID as number]),
      ),
    );
    setError(null);
    setBuilding(false);
  }, [open, allIDs, parents]);

  const allSelected = writable.length > 0 && selectedAttrIDs.length === writable.length;
  const someSelected = selectedAttrIDs.length > 0 && !allSelected;
  const uniqueUnavailable = !unique || !writable.some((attribute) => attribute.id === unique.id);

  const toggleAttr = (id: number, checked: boolean) => {
    setSelectedAttrIDs((current) =>
      checked ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );
  };

  const toggleAll = (checked: boolean) => {
    if (checked) {
      setSelectedAttrIDs(allIDs);
      return;
    }
    setSelectedAttrIDs(unique ? [unique.id] : []);
  };

  const toggleParent = (id: number, checked: boolean) => {
    setSelectedParentIDs((current) =>
      checked ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );
  };

  const download = async () => {
    if (uniqueUnavailable) return;
    const columns = templateColumns({
      attributes,
      selectedAttrIDs,
      parents,
      selectedParentIDs,
      parentAttrIDs,
    });
    if (columns.length === 0) {
      setError(tr('至少选择一列再下载。', 'Select at least one column before downloading.'));
      return;
    }
    setBuilding(true);
    setError(null);
    try {
      const blob = await buildTemplateBlob(columns);
      const base = (model.alias || model.name).replace(/[\\/:*?"<>|]/g, '_');
      downloadBlob(`${base}-template.xlsx`, blob);
      onClose();
    } catch {
      setError(tr('无法生成模板。', 'Could not build the template.'));
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('下载导入模板', 'Download import template')}
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={building}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void download()}
            disabled={building || uniqueUnavailable || selectedAttrIDs.length === 0}
          >
            {building ? (
              <Loader2 size={12} className="me-1.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download size={12} className="me-1.5" aria-hidden="true" />
            )}
            {building ? tr('生成中…', 'Building…') : tr('下载模板', 'Download template')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-xs leading-relaxed text-text-muted">
          {tr(
            '模板的列就是导入时的表头。属性列使用模型里的显示名；关系列写成 $父模型名.属性，导入时按该属性的值找到父实例并建立关系。',
            'The template columns are the import headers. Attribute columns use the model’s display name; relation columns are written $parentModelName.attribute and resolve the parent instance by that value.',
          )}
        </p>

        {uniqueUnavailable && (
          <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {tr(
              `唯一标识属性${unique ? `「${attributeHeader(attributes, unique)}」` : ''}不能从表格导入（可能是计算、密码或文件属性），因此无法生成可用的模板。`,
              `The identifying attribute${unique ? ` “${attributeHeader(attributes, unique)}”` : ''} cannot be imported from a sheet (it may be computed, a secret or a file), so no usable template can be built.`,
            )}
          </div>
        )}

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-text">{tr('模型属性', 'Model attributes')}</h3>
            <Label className="flex items-center gap-2 text-xs font-normal text-text-muted">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                disabled={writable.length === 0}
                onCheckedChange={(checked) => toggleAll(Boolean(checked))}
                aria-label={tr('全选属性', 'Select all attributes')}
              />
              {tr('全选', 'Select all')}
            </Label>
          </div>
          <div className="grid max-h-64 grid-cols-1 gap-x-4 gap-y-2 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
            {writable.length === 0 && (
              <p className="text-xs text-text-muted">
                {tr('这个模型没有可以从表格写入的属性。', 'This model has no attribute a sheet can write.')}
              </p>
            )}
            {writable.map((attribute) => {
              const isUnique = unique?.id === attribute.id;
              return (
                <Label
                  key={attribute.id}
                  className="flex min-w-0 items-center gap-2 text-xs font-normal"
                  title={attributeHeader(attributes, attribute)}
                >
                  <Checkbox
                    checked={isUnique || selectedAttrIDs.includes(attribute.id)}
                    disabled={isUnique}
                    onCheckedChange={(checked) => toggleAttr(attribute.id, Boolean(checked))}
                    aria-label={attributeHeader(attributes, attribute)}
                  />
                  <span className="truncate">{attributeHeader(attributes, attribute)}</span>
                  {isUnique && (
                    <span className="shrink-0 text-danger" aria-label={tr('唯一标识', 'Identifier')}>
                      *
                    </span>
                  )}
                </Label>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-sm font-medium text-text">{tr('模型关系', 'Model relations')}</h3>
          {parents.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-text-muted">
              {tr(
                '这个模型没有可作为父级的模型关系，模板只包含属性列。',
                'This model has no parent relation, so the template contains attribute columns only.',
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {parents.map((parent) => {
                const checked = selectedParentIDs.includes(parent.related.ctr_id);
                const attrID = parentAttrIDs[parent.related.ctr_id] ?? parent.defaultAttrID ?? 0;
                const attribute = parent.attributes.find((candidate) => candidate.id === attrID);
                return (
                  <div
                    key={parent.related.ctr_id}
                    className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 sm:flex-row sm:items-center"
                  >
                    <Label className="flex min-w-0 items-center gap-2 text-xs font-normal sm:w-44">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => toggleParent(parent.related.ctr_id, Boolean(next))}
                        aria-label={parent.related.type.alias || parent.related.type.name}
                      />
                      <span className="truncate" title={parent.related.type.alias || parent.related.type.name}>
                        {parent.related.type.alias || parent.related.type.name}
                      </span>
                    </Label>
                    <Select
                      value={String(attrID)}
                      onValueChange={(value) =>
                        setParentAttrIDs((current) => ({
                          ...current,
                          [parent.related.ctr_id]: Number(value),
                        }))
                      }
                      options={parent.attributes.map((candidate) => ({
                        value: String(candidate.id),
                        label: attributeHeader(parent.related.attributes ?? [], candidate),
                      }))}
                      label={tr(
                        `${parent.related.type.alias || parent.related.type.name} 的匹配属性`,
                        `${parent.related.type.alias || parent.related.type.name} match attribute`,
                      )}
                      disabled={!checked}
                      className="min-w-0 flex-1"
                    />
                    {attribute && (
                      <code className="max-w-full truncate rounded bg-zinc-800/50 px-1.5 py-1 text-[11px] text-text-muted sm:max-w-56">
                        {relationHeader(parent.related, attribute, parent.related.attributes ?? [])}
                      </code>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <p className="text-[11px] leading-relaxed text-text-faint">
          {tr(
            '关系列表头在模板中为红色。选择型属性的可选值会写入 Excel 下拉框；Excel 限制单个下拉列表最长 255 个字符，超过时不写入下拉框。单个文件最多 5000 行。',
            'Relation headers are red in the template. Choice attributes get an Excel dropdown; Excel limits a list to 255 characters, so a longer set is left as free text. One file may carry up to 5000 rows.',
          )}
        </p>

        {error && (
          <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
