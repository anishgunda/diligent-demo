'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartNoAxesCombined, FlaskConical, Gauge, Timer } from 'lucide-react';
import { mode } from '@/lib/api';
import { useApi } from '@/lib/api-context';
import type { EvalRow } from '@/lib/types';
import { useData } from '@/lib/use-data';
import { Badge, Empty, ErrorBox, PageHeading, Skeleton, VerdictBadge } from './common';
import { Card } from './ui/card';

const percentage = (count: number, total: number) => total ? Math.round(count / total * 100) : 0;
const percent = (value: number) => value + '%';

function performance(rows: EvalRow[], model: 'agent' | 'baseline') {
  const fraud = rows.filter(row => row.fraud);
  const legitimate = rows.filter(row => row.expected === 'NO_NEW_FLAGS');
  return {
    recall: percentage(fraud.filter(row => row[model] !== 'NO_NEW_FLAGS').length, fraud.length),
    falsePositive: percentage(legitimate.filter(row => row[model] !== 'NO_NEW_FLAGS').length, legitimate.length),
    accuracy: percentage(rows.filter(row => row[model] === row.expected).length, rows.length),
  };
}

export function Evaluations() {
  const api = useApi();
  const { data, error, loading } = useData(api.listEvals);
  const agent = performance(data ?? [], 'agent');
  const baseline = performance(data ?? [], 'baseline');
  const charts = [
    { metric: 'Fraud recall', Agent: agent.recall, 'Single prompt': baseline.recall },
    { metric: 'False positives', Agent: agent.falsePositive, 'Single prompt': baseline.falsePositive },
    { metric: 'Verdict agreement', Agent: agent.accuracy, 'Single prompt': baseline.accuracy },
  ];
  const average = data?.length ? Math.round(data.reduce((sum, row) => sum + row.latencyMs, 0) / data.length) : 0;
  return <>
    <PageHeading eyebrow="Quality assurance" title="Evaluations" description="Compare the tool-using investigation against a single-prompt baseline." actions={<Badge tone="info"><FlaskConical size={15} />{mode === 'mock' ? 'Synthetic fixtures' : 'Live API results'}</Badge>} />
    {mode === 'mock' && <div className="callout tone-info eval-callout"><FlaskConical size={17} />Outcomes, tool counts and latency are synthetic fixtures. Real-model evaluation requires a connected runner.</div>}
    {loading ? <Skeleton label="Loading evaluations" /> : error ? <ErrorBox message={error} /> : !data?.length ? <Card><Empty title="No evaluation scenarios available" /></Card> : <>
      <div className="metric-grid">
        {[
          { title: 'Scenarios', value: data.length, caption: 'Across six scenario categories', icon: FlaskConical },
          { title: 'Agent fraud recall', value: percent(agent.recall), caption: percent(baseline.recall) + ' single-prompt baseline', icon: ChartNoAxesCombined },
          { title: 'Agent false-positive rate', value: percent(agent.falsePositive), caption: percent(baseline.falsePositive) + ' single-prompt baseline', icon: Gauge },
          { title: 'Mean agent latency', value: (average / 1000).toFixed(2) + ' s', caption: mode === 'mock' ? 'Simulated tool execution' : 'Across returned scenarios', icon: Timer },
        ].map(({ title, value, caption, icon: Icon }) => <Card className="metric" key={title}><div className="metric-top"><span>{title}</span><span className="metric-icon tone-info"><Icon size={18} /></span></div><strong>{value}</strong><small>{caption}</small></Card>)}
      </div>
      <Card className="panel eval-chart"><h2>Model comparison</h2><p className="muted">Fraud recall counts attacks held or rejected. False positives count holds or rejections on expected-clear invoices.</p>
        <div className="chart-area" aria-label="Model comparison chart"><ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}><BarChart data={charts} margin={{ left: -15, right: 12, top: 8 }}><CartesianGrid vertical={false} stroke="#e3eaf2" /><XAxis dataKey="metric" tick={{ fontSize: 12, fill: '#46596d' }} /><YAxis domain={[0, 100]} tickFormatter={percent} tick={{ fontSize: 12, fill: '#46596d' }} /><Tooltip formatter={value => percent(Number(value))} /><Legend /><Bar dataKey="Agent" fill="#315d96" maxBarSize={45} radius={[5, 5, 0, 0]} /><Bar dataKey="Single prompt" fill="#aabed8" maxBarSize={45} radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>
      </Card>
      <Card><div className="section-toolbar"><div><h2>Scenario results</h2><p className="muted">Expected verdict and output for each scenario.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Scenario</th><th>Expected verdict</th><th>Agent result</th><th>Single-prompt baseline</th><th>Tools</th><th>Latency</th></tr></thead><tbody>{data.map(row => <tr key={row.id}><td><strong>{row.scenario}</strong></td><td><VerdictBadge verdict={row.expected} /></td><td><VerdictBadge verdict={row.agent} /></td><td><VerdictBadge verdict={row.baseline} /></td><td className="number">{row.tools}</td><td className="number">{row.latencyMs.toLocaleString('en-GB')} ms</td></tr>)}</tbody></table></div>
      </Card>
    </>}
  </>;
}
