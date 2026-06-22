import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

interface ImportPreviewRow {
  rowNumber: number;
  action: 'create' | 'update';
  name: string;
  slug: string;
  existingId: number | null;
  existingName: string;
  existingSlug: string;
}

interface ImportModeOption {
  value: string;
  label: string;
  description: string;
  destructive: boolean;
  checked: boolean;
}

export async function importPage(views: Fetcher, opts: BaseTemplateProps & {
  pageType: string;
  mode?: 'json' | 'csv' | 'confirm';
  action?: string;
  sampleHeaders?: string[];
  csvText?: string;
  previewRows?: ImportPreviewRow[];
  skippedCount?: number;
  importModeOptions?: ImportModeOption[];
}): Promise<string> {
  const {
    pageType,
    mode = 'json',
    action = '',
    sampleHeaders = [],
    csvText = '',
    previewRows = [],
    skippedCount = 0,
    importModeOptions = [],
  } = opts;
  const newRows = previewRows.filter((row) => row.action === 'create');
  const existingRows = previewRows.filter((row) => row.action === 'update');
  const body = await renderView(views, '/templates/import.json', {
    pageType,
    action,
    backHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
    isCsvImport: mode === 'csv',
    isConfirmImport: mode === 'confirm',
    sampleCsvHeader: sampleHeaders.join(','),
    csvText,
    previewRows,
    newRows,
    existingRows,
    hasPreviewRows: previewRows.length > 0,
    hasNewRows: newRows.length > 0,
    hasExistingRows: existingRows.length > 0,
    previewCount: previewRows.length,
    newCount: newRows.length,
    existingCount: existingRows.length,
    skippedCount,
    importModeOptions,
    hasImportModeOptions: importModeOptions.length > 0,
  });

  return adminLayout(views, opts, { title: 'Import', body });
}
