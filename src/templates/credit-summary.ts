import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface CreditSummaryRow {
  pluginLabel: string;
  pluginId: string;
  key: string;
  label: string;
  description: string;
  chargeLabel: string;
  chargeKey: string;
  chargeValue: string;
  effectiveLabel: string;
  effectiveFree: boolean;
  effectiveValue: number;
  manageHref: string;
}

export interface LimitSummaryRow {
  pluginLabel: string;
  pluginId: string;
  key: string;
  label: string;
  description: string;
  scopeLabel: string;
  scopeKey: string;
  scopeValue: string;
  effectiveLabel: string;
  effectiveUnlimited: boolean;
  effectiveValue: number | null;
  manageHref: string;
}

export async function creditSummaryPage(views: Fetcher, opts: BaseTemplateProps & {
  rows: CreditSummaryRow[];
  limitRows: LimitSummaryRow[];
  pluginCount: number;
  chargeCount: number;
  paidCount: number;
  canConfigure: boolean;
}): Promise<string> {
  const body = await renderView(views, '/templates/credit-summary.json', {
    hasRows: opts.rows.length > 0,
    rows: opts.rows,
    hasLimitRows: opts.limitRows.length > 0,
    limitRows: opts.limitRows,
    pluginCount: opts.pluginCount,
    chargeCount: opts.chargeCount,
    paidCount: opts.paidCount,
    canConfigure: opts.canConfigure,
  });

  return adminLayout(views, opts, { title: 'Credit Summary', body });
}
