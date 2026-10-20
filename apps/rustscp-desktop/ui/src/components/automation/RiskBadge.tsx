import React from 'react';

export type RiskTone = 'safe' | 'warning' | 'dangerous';

const STYLES: Record<RiskTone, string> = {
  safe: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  dangerous: 'bg-red-500/10 text-red-700 dark:text-red-400',
};

export function riskLabel(risk: RiskTone, isPt: boolean): string {
  switch (risk) {
    case 'safe':
      return isPt ? 'Seguro' : 'Safe';
    case 'warning':
      return isPt ? 'Atenção' : 'Warning';
    default:
      return isPt ? 'Destrutivo' : 'Dangerous';
  }
}

/** Small semantic pill for an action's risk level. */
export const RiskBadge: React.FC<{ risk: RiskTone; isPt: boolean; label?: string; className?: string }> = ({
  risk,
  isPt,
  label,
  className = '',
}) => (
  <span
    className={`inline-flex items-center h-5 px-1.5 rounded-md text-[11px] font-medium whitespace-nowrap ${STYLES[risk] ?? STYLES.dangerous} ${className}`}
  >
    {label ?? riskLabel(risk, isPt)}
  </span>
);
