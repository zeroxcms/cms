import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface CreditSummaryRow {
  pluginLabel: string;
  pluginId: string;
  key: string;
  label: string;
  description: string;
  chargeLabel: string;
  effectiveLabel: string;
  defaultLabel: string;
  sourceLabel: string;
  manageHref: string;
}

export async function creditSummaryPage(views: Fetcher, opts: BaseTemplateProps & {
  rows: CreditSummaryRow[];
  pluginCount: number;
  chargeCount: number;
  paidCount: number;
}): Promise<string> {
  const body = await renderView(views, '/templates/credit-summary.json', {
    hasRows: opts.rows.length > 0,
    rows: opts.rows,
    pluginCount: opts.pluginCount,
    chargeCount: opts.chargeCount,
    paidCount: opts.paidCount,
  });

  return adminLayout(views, opts, { title: 'Credit Summary', body });
}
