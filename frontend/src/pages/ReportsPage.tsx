import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart3,
  Download,
  Calendar,
  FileSpreadsheet,
  FileText,
  Filter,
  RefreshCw,
  Table,
  Clock,
  Truck,
  CheckCircle2,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  AlertTriangle,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { reportService, dashboardService, type PassagePageParams } from '../services/api.js';
import { useAuth } from '../contexts/AuthContext.js';

type ReportType = 'daily' | 'weekly' | 'monthly' | 'yearly';

// Reports are kept in India time, so "today" must be the date in Kolkata, not in UTC
const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayIST = () => IST_DATE.format(new Date());
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const PAGE_SIZES = [25, 50, 100, 250];
const SERIES_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4'];

interface PassagePagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Page numbers to show: always the first and last, and the pages around the current one */
function pageNumbers(current: number, total: number): Array<number | 'gap'> {
  const pages = new Set([1, total, current - 1, current, current + 1].filter((p) => p >= 1 && p <= total));
  const sorted = [...pages].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

export const ReportsPage: React.FC = () => {
  const { user, isOperator } = useAuth();
  const today = todayIST();
  const [reportType, setReportType] = useState<ReportType>('daily');
  const [day, setDay] = useState<string>(today);
  const [rangeStart, setRangeStart] = useState<string>(addDays(today, -6));
  const [rangeEnd, setRangeEnd] = useState<string>(today);
  const [month, setMonth] = useState<string>(today.slice(0, 7));
  const [year, setYear] = useState<string>(today.slice(0, 4));
  const [selectedLocation, setSelectedLocation] = useState<string>('all');
  const [paging, setPaging] = useState<PassagePageParams>({ page: 1, pageSize: 50, sort: 'newest' });
  const [reportData, setReportData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'excel' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [locations, setLocations] = useState<any[]>([]);
  const latestRequestRef = useRef(0);

  // Load locations for filter dropdown
  useEffect(() => {
    dashboardService.getLocations().then((res) => {
      setLocations(res.locations || []);
      if (isOperator && user?.assigned_location_id) {
        setSelectedLocation(String(user.assigned_location_id));
      }
    });
  }, [isOperator, user]);

  /** Change a filter and go back to the first page of passages */
  const withFirstPage = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPaging((p) => ({ ...p, page: 1 }));
  };
  const changeReportType = withFirstPage(setReportType);
  const changeDay = withFirstPage(setDay);
  const changeRangeStart = withFirstPage(setRangeStart);
  const changeRangeEnd = withFirstPage(setRangeEnd);
  const changeMonth = withFirstPage(setMonth);
  const changeYear = withFirstPage(setYear);
  const changeLocation = withFirstPage(setSelectedLocation);

  const locationId = selectedLocation !== 'all' ? Number(selectedLocation) : undefined;

  // Fetch report data; only the newest request may update the page
  const fetchReport = async () => {
    const requestId = ++latestRequestRef.current;
    try {
      setIsLoading(true);
      setLoadError(null);

      let data: any;
      if (reportType === 'daily') {
        data = await reportService.getDaily(day, locationId, paging);
      } else if (reportType === 'weekly') {
        data = await reportService.getWeekly(rangeStart, rangeEnd, locationId, paging);
      } else if (reportType === 'monthly') {
        data = await reportService.getMonthly(month, locationId, paging);
      } else {
        data = await reportService.getYearly(year, locationId, paging);
      }

      if (requestId === latestRequestRef.current) setReportData(data);
    } catch (err: any) {
      console.error('Error fetching report:', err);
      if (requestId === latestRequestRef.current) {
        setLoadError(err.response?.data?.error || 'Could not load the report. Check the connection and try again.');
      }
    } finally {
      if (requestId === latestRequestRef.current) setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [reportType, day, rangeStart, rangeEnd, month, year, selectedLocation, paging]);

  // Export handlers: downloaded through the API so the login token goes along
  const handleExport = async (format: 'csv' | 'excel') => {
    setExporting(format);
    setExportError(null);
    try {
      await reportService.downloadExport({
        format,
        type: reportType,
        ...(reportType === 'daily' && { date: day }),
        ...(reportType === 'weekly' && { startDate: rangeStart, endDate: rangeEnd }),
        ...(reportType === 'monthly' && { month }),
        ...(reportType === 'yearly' && { year }),
        ...(locationId !== undefined && { locationId }),
      });
    } catch (err: any) {
      setExportError(err.message || 'Export failed. Try again.');
    } finally {
      setExporting(null);
    }
  };

  const yearOptions = Array.from({ length: 6 }, (_, i) => String(Number(today.slice(0, 4)) - i));
  const pagination: PassagePagination | undefined = reportData?.passagesPagination;
  const passageTotal = pagination?.total ?? reportData?.vehiclePassages?.length ?? 0;
  const locationRows: any[] = reportData ? reportData.locations || reportData.locationTotals || [] : [];
  const periodTotal = locationRows.reduce((sum, l) => sum + (l.total || 0), 0);
  const chartSeries = locationRows.map((l, i) => ({
    key: String(l.locationName).toLowerCase(),
    name: String(l.locationName).charAt(0) + String(l.locationName).slice(1).toLowerCase(),
    color: SERIES_COLORS[i % SERIES_COLORS.length],
  }));

  const pill = (active: boolean) =>
    `px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
      active ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
    }`;
  const inputClass = 'text-xs rounded-lg border-slate-300 border px-2.5 py-1.5 bg-white font-mono focus:outline-none';

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-200 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-blue-600" />
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight uppercase">
              Operational Reports & Analytics
            </h1>
          </div>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Historical vehicle movements, daily/weekly/monthly trends, approved audit corrections, and official exports (Asia/Kolkata)
          </p>
        </div>

        {/* Export Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleExport('csv')}
            disabled={exporting !== null}
            className="px-3.5 py-2 text-xs font-bold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors disabled:opacity-60"
          >
            {exporting === 'csv' ? <RefreshCw className="w-4 h-4 text-slate-500 animate-spin" /> : <FileText className="w-4 h-4 text-slate-500" />}
            Export CSV
          </button>
          <button
            onClick={() => handleExport('excel')}
            disabled={exporting !== null}
            className="px-3.5 py-2 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors disabled:opacity-60"
          >
            {exporting === 'excel' ? <RefreshCw className="w-4 h-4 text-emerald-300 animate-spin" /> : <FileSpreadsheet className="w-4 h-4 text-emerald-300" />}
            Export Excel
          </button>
        </div>
      </div>

      {exportError && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          Export failed: {exportError}
        </div>
      )}

      {/* Filter Toolbar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex flex-wrap items-center justify-between gap-4">
        {/* Report Type Tabs */}
        <div className="flex items-center bg-slate-100 p-1 rounded-lg">
          {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((t) => (
            <button
              key={t}
              onClick={() => changeReportType(t)}
              className={`px-3 py-1.5 text-xs font-bold rounded-md capitalize transition-colors ${
                reportType === t
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t} Report
            </button>
          ))}
        </div>

        {/* Period and Location Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          {reportType === 'daily' && (
            <>
              <button className={pill(day === today)} onClick={() => changeDay(today)}>Today</button>
              <button className={pill(day === addDays(today, -1))} onClick={() => changeDay(addDays(today, -1))}>Yesterday</button>
              <input type="date" value={day} max={today} onChange={(e) => e.target.value && changeDay(e.target.value)} className={inputClass} />
            </>
          )}

          {reportType === 'weekly' && (
            <>
              <button
                className={pill(rangeStart === addDays(today, -6) && rangeEnd === today)}
                onClick={() => {
                  changeRangeStart(addDays(today, -6));
                  changeRangeEnd(today);
                }}
              >
                Last 7 Days
              </button>
              <input type="date" value={rangeStart} max={rangeEnd} onChange={(e) => e.target.value && changeRangeStart(e.target.value)} className={inputClass} />
              <span className="text-xs text-slate-400">to</span>
              <input type="date" value={rangeEnd} min={rangeStart} max={today} onChange={(e) => e.target.value && changeRangeEnd(e.target.value)} className={inputClass} />
            </>
          )}

          {reportType === 'monthly' && (
            <>
              <button className={pill(month === today.slice(0, 7))} onClick={() => changeMonth(today.slice(0, 7))}>This Month</button>
              <input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && changeMonth(e.target.value)} className={inputClass} />
            </>
          )}

          {reportType === 'yearly' && (
            <select value={year} onChange={(e) => changeYear(e.target.value)} className={inputClass}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          )}

          {/* Location Selector (Disabled for Operator) */}
          <select
            value={selectedLocation}
            disabled={isOperator}
            onChange={(e) => changeLocation(e.target.value)}
            className="text-xs rounded-lg border-slate-300 border px-3 py-1.5 bg-slate-50 font-medium focus:outline-none disabled:opacity-60"
          >
            {!isOperator && <option value="all">All Locations (Combined)</option>}
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>

          <button
            onClick={fetchReport}
            title="Refresh"
            className="p-1.5 text-slate-600 hover:text-slate-900 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {loadError && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {loadError}
        </div>
      )}

      {/* Summary KPI Cards */}
      {reportData && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <span className="text-xs font-bold text-slate-500 uppercase">Total Vehicle Passages</span>
            <div className="text-3xl font-black text-slate-900 font-mono mt-1">
              {(reportData.totalTrucks || reportData.grandTotal || reportData.combinedAnnualCount || 0).toLocaleString()}
            </div>
            <span className="text-[11px] text-slate-400 font-mono mt-1 block">
              Reflects approved manual corrections
            </span>
          </div>

          {reportData.averageDailyCount !== undefined && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
              <span className="text-xs font-bold text-slate-500 uppercase">Average Daily Movement</span>
              <div className="text-3xl font-black text-blue-600 font-mono mt-1">
                {reportData.averageDailyCount}
              </div>
              <span className="text-[11px] text-slate-400 font-mono mt-1 block">
                Trucks per 24-hour operational day
              </span>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <span className="text-xs font-bold text-slate-500 uppercase">Operating Timezone</span>
            <div className="text-xl font-black text-slate-800 font-mono mt-2">
              Asia/Kolkata (IST)
            </div>
            <span className="text-[11px] text-slate-400 font-mono mt-1 block">
              Standard MCD Reporting Windows
            </span>
          </div>
        </div>
      )}

      {/* Visual Analytics Chart */}
      {reportData && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="font-bold text-sm text-slate-900 mb-4 uppercase tracking-wide">
            {reportType === 'daily'
              ? '24-Hour Movement Profile'
              : reportType === 'weekly'
              ? '7-Day Comparative Movement'
              : reportType === 'monthly'
              ? 'Daily Passages Across Month'
              : 'Annual Monthly Profile (Jan - Dec)'}
          </h3>

          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {reportType === 'daily' ? (
                <BarChart data={reportData.hourlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                  <XAxis dataKey="hour" tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} interval={2} />
                  <YAxis tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip contentStyle={{ backgroundColor: '#0F172A', color: '#fff', borderRadius: '8px' }} />
                  <Bar dataKey="total" fill="#3B82F6" radius={[4, 4, 0, 0]} name="Trucks" />
                </BarChart>
              ) : reportType === 'weekly' || reportType === 'monthly' ? (
                <BarChart data={reportData.dailyBreakdown} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                  <XAxis dataKey="date" tickLine={false} tick={{ fontSize: 10, fill: '#64748B' }} />
                  <YAxis tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip contentStyle={{ backgroundColor: '#0F172A', color: '#fff', borderRadius: '8px' }} />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: '10px', fontSize: '12px' }} />
                  {chartSeries.map((series) => (
                    <Bar key={series.key} dataKey={series.key} name={series.name} fill={series.color} stackId="a" />
                  ))}
                </BarChart>
              ) : (
                <BarChart data={reportData.monthlyBreakdown} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                  <XAxis dataKey="month" tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                  <YAxis tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip contentStyle={{ backgroundColor: '#0F172A', color: '#fff', borderRadius: '8px' }} />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: '10px', fontSize: '12px' }} />
                  {chartSeries.map((series) => (
                    <Bar key={series.key} dataKey={series.key} name={series.name} fill={series.color} stackId="a" />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Location Breakdown Table */}
      {reportData && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-bold text-xs uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <Table className="w-4 h-4 text-blue-600" />
              Location Performance Breakdown
            </h3>
          </div>

          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-5 py-3 text-left font-bold text-slate-600 uppercase">Location</th>
                {reportType === 'daily' && (
                  <>
                    <th className="px-5 py-3 text-right font-bold text-slate-600 uppercase">Camera Count</th>
                    <th className="px-5 py-3 text-right font-bold text-slate-600 uppercase">Manual Correction</th>
                  </>
                )}
                <th className="px-5 py-3 text-right font-bold text-slate-600 uppercase">Share</th>
                <th className="px-5 py-3 text-right font-bold text-slate-600 uppercase">Verified Camera Passages</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {locationRows.map((loc: any) => (
                <tr key={loc.locationId} className="hover:bg-slate-50">
                  <td className="px-5 py-3 text-slate-800 font-sans font-bold">{loc.locationName}</td>
                  {reportType === 'daily' && (
                    <>
                      <td className="px-5 py-3 text-right text-slate-700">{loc.automaticCount ?? '-'}</td>
                      <td className={`px-5 py-3 text-right ${loc.manualAdjustment ? 'text-amber-700 font-bold' : 'text-slate-400'}`}>
                        {loc.manualAdjustment > 0 ? `+${loc.manualAdjustment}` : loc.manualAdjustment ?? '-'}
                      </td>
                    </>
                  )}
                  <td className="px-5 py-3 text-right text-slate-500">
                    {periodTotal > 0 ? `${Math.round((loc.total / periodTotal) * 100)}%` : '-'}
                  </td>
                  <td className="px-5 py-3 text-right text-slate-900 font-black text-sm">{loc.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Individual Truck Passage Timings Log */}
      {reportData && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-600" />
                Truck Passage Timings Log
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Exact passage timestamps recorded when verified heavy trucks traversed the wheel-wash bay (Asia/Kolkata)
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold self-start sm:self-auto font-mono">
              <Truck className="w-3.5 h-3.5" />
              <span>{passageTotal.toLocaleString()} Verified Crossings</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50/80">
                <tr>
                  <th className="px-4 py-3 text-left font-bold text-slate-600 uppercase tracking-wider">Passage #</th>
                  <th className="px-4 py-3 text-left font-bold text-slate-600 uppercase tracking-wider">Crossing Time (IST)</th>
                  <th className="px-4 py-3 text-left font-bold text-slate-600 uppercase tracking-wider">Date</th>
                  <th className="px-4 py-3 text-left font-bold text-slate-600 uppercase tracking-wider">Location</th>
                  <th className="px-4 py-3 text-left font-bold text-slate-600 uppercase tracking-wider">Classification</th>
                  <th className="px-4 py-3 text-left font-bold text-slate-600 uppercase tracking-wider">Detection Source</th>
                  <th className="px-4 py-3 text-right font-bold text-slate-600 uppercase tracking-wider">Wash Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {reportData.vehiclePassages && reportData.vehiclePassages.length > 0 ? (
                  reportData.vehiclePassages.map((p: any) => (
                    <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-slate-500 font-bold">
                        #{p.passageNumber}
                      </td>
                      <td className="px-4 py-3 text-slate-900 font-black">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                          <Clock className="w-3 h-3 text-blue-600" />
                          {p.time}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-medium">
                        {p.date}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded font-sans font-bold text-[11px] ${
                            p.locationName?.toUpperCase() === 'GHAZIPUR'
                              ? 'bg-blue-100 text-blue-800'
                              : p.locationName?.toUpperCase() === 'OKHLA'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {p.locationName}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700 font-sans font-semibold">
                        {p.vehicleType || 'Heavy Commercial Truck'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-sans">
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                          <ShieldCheck className="w-3.5 h-3.5 text-blue-500" />
                          {p.detectionSource || 'Live CCTV AI'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-sans">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          {p.status || 'WASHED & RECORDED'}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400 font-sans">
                      <Truck className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-[1.5]" />
                      <p className="font-semibold text-slate-600">No truck passages recorded for this period.</p>
                      <p className="text-xs text-slate-400 mt-1">Crossings will automatically appear here as trucks pass through the wheel-wash.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination && pagination.total > 0 && (
            <PassagePager
              pagination={pagination}
              sort={paging.sort}
              isLoading={isLoading}
              onPage={(page) => setPaging((p) => ({ ...p, page }))}
              onPageSize={(pageSize) => setPaging((p) => ({ ...p, pageSize, page: 1 }))}
              onSort={(sort) => setPaging((p) => ({ ...p, sort, page: 1 }))}
            />
          )}
        </div>
      )}
    </div>
  );
};

/** Footer under the passage log: range shown, rows per page, sort order and page buttons */
const PassagePager: React.FC<{
  pagination: PassagePagination;
  sort: 'newest' | 'oldest';
  isLoading: boolean;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
  onSort: (sort: 'newest' | 'oldest') => void;
}> = ({ pagination, sort, isLoading, onPage, onPageSize, onSort }) => {
  const { page, pageSize, total, totalPages } = pagination;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const button = (disabled: boolean) =>
    `min-w-[2rem] h-8 px-2 rounded-lg border text-xs font-semibold flex items-center justify-center transition-colors ${
      disabled ? 'border-slate-200 text-slate-300 cursor-not-allowed' : 'border-slate-300 text-slate-700 hover:bg-slate-50'
    }`;

  return (
    <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/60 flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-3 text-slate-600">
        <span>
          Showing <strong className="font-mono text-slate-900">{first.toLocaleString()}–{last.toLocaleString()}</strong> of{' '}
          <strong className="font-mono text-slate-900">{total.toLocaleString()}</strong> passages
        </span>
        <label className="flex items-center gap-1.5">
          Rows
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="rounded-lg border border-slate-300 px-2 py-1 bg-white font-mono focus:outline-none"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Order
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value as 'newest' | 'oldest')}
            className="rounded-lg border border-slate-300 px-2 py-1 bg-white focus:outline-none"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>

      <nav className={`flex items-center gap-1 ${isLoading ? 'opacity-60' : ''}`} aria-label="Passage log pages">
        <button className={button(page === 1)} disabled={page === 1} onClick={() => onPage(1)} title="First page">
          <ChevronsLeft className="w-4 h-4" />
        </button>
        <button className={button(page === 1)} disabled={page === 1} onClick={() => onPage(page - 1)} title="Previous page">
          <ChevronLeft className="w-4 h-4" />
        </button>
        {pageNumbers(page, totalPages).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="px-1 text-slate-400">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={
                p === page
                  ? 'min-w-[2rem] h-8 px-2 rounded-lg bg-blue-600 text-white text-xs font-bold font-mono'
                  : `${button(false)} font-mono`
              }
            >
              {p}
            </button>
          )
        )}
        <button className={button(page === totalPages)} disabled={page === totalPages} onClick={() => onPage(page + 1)} title="Next page">
          <ChevronRight className="w-4 h-4" />
        </button>
        <button className={button(page === totalPages)} disabled={page === totalPages} onClick={() => onPage(totalPages)} title="Last page">
          <ChevronsRight className="w-4 h-4" />
        </button>
      </nav>
    </div>
  );
};
