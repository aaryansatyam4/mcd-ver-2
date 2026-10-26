import ExcelJS from 'exceljs';
import { db } from '../database/excelDb.js';
import { CountService } from './countService.js';
import { getKolkataDateString, calculateDateRange, } from '../utils/dateUtils.js';
export const PASSAGE_PAGE_SIZES = [25, 50, 100, 250];
const DEFAULT_PASSAGE_PAGE_SIZE = 50;
/** Read page / pageSize / sort from query parameters, falling back to sensible values */
export function parsePassagePageOptions(query) {
    const page = parseInt(String(query.page ?? ''), 10);
    const pageSize = parseInt(String(query.pageSize ?? ''), 10);
    return {
        page: Number.isFinite(page) && page > 0 ? page : 1,
        pageSize: PASSAGE_PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PASSAGE_PAGE_SIZE,
        sort: query.sort === 'oldest' ? 'oldest' : 'newest',
    };
}
// The weekly report builds one row per day; keep custom ranges to about a quarter
const MAX_RANGE_DAYS = 92;
/** A report request the user can fix (e.g. a range that is too long); answered with HTTP 400 */
export class ReportRangeError extends Error {
}
function daysBetween(start, end) {
    return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}
const SOURCE_LABELS = {
    automatic: 'Live CCTV AI',
    demo_simulated: 'Simulation',
};
export class ReportService {
    /**
     * Helper: Retrieve individual vehicle passages with timing and classification
     */
    static getPassagesForDateFilter(filterFn, locationId, pageOptions) {
        const locMap = new Map(db.getLocations().map((l) => [l.id, l.name]));
        const events = db.getVehicleEvents().filter((e) => {
            const matchLoc = locationId ? e.location_id === locationId : true;
            const parts = e.event_timestamp.split(' ');
            const datePart = parts[0];
            return matchLoc && filterFn(datePart, e.event_timestamp);
        });
        const passages = events
            .sort((a, b) => b.event_timestamp.localeCompare(a.event_timestamp))
            .map((e, idx) => {
            const parts = e.event_timestamp.split(' ');
            const datePart = parts[0];
            const timePart = parts[1] || parts[0];
            return {
                id: e.id,
                passageNumber: events.length - idx,
                locationId: e.location_id,
                locationName: locMap.get(e.location_id) || `Site #${e.location_id}`,
                timestamp: e.event_timestamp,
                time: timePart,
                date: datePart,
                // Anything else was typed into the Google Sheet by hand
                detectionSource: SOURCE_LABELS[e.detection_source] ?? 'Manual Entry',
                vehicleType: 'Heavy Commercial Truck',
                status: 'WASHED & COUNTED',
            };
        });
        // Passage numbers are counted over the whole period, so they stay the same on every page
        const total = passages.length;
        if (!pageOptions) {
            return {
                vehiclePassages: passages,
                passagesPagination: { page: 1, pageSize: total, total, totalPages: 1, sort: 'newest' },
            };
        }
        const { pageSize, sort } = pageOptions;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(pageOptions.page, totalPages);
        const ordered = sort === 'oldest' ? passages.reverse() : passages;
        return {
            vehiclePassages: ordered.slice((page - 1) * pageSize, page * pageSize),
            passagesPagination: { page, pageSize, total, totalPages, sort },
        };
    }
    /**
     * Daily Report: Hourly distribution + daily totals + individual passage timings
     */
    static getDailyReport(dateStr = getKolkataDateString(), locationId, pageOptions) {
        const locations = db.getLocations().filter((l) => (locationId ? l.id === locationId : true));
        const hourlyData = CountService.getHourlyCounts(dateStr, locationId);
        const locationTotals = locations.map((loc) => {
            const counts = CountService.getLocationCount(loc.id, dateStr);
            return {
                locationId: loc.id,
                locationName: loc.name,
                automaticCount: counts.automaticCount,
                manualAdjustment: counts.manualAdjustment,
                total: counts.total,
            };
        });
        const totalTrucks = locationTotals.reduce((sum, l) => sum + l.total, 0);
        const passages = ReportService.getPassagesForDateFilter((d) => d === dateStr, locationId, pageOptions);
        return {
            type: 'daily',
            date: dateStr,
            locations: locationTotals,
            totalTrucks,
            hourlyData,
            ...passages,
        };
    }
    /**
     * Weekly Report: 7-day movement, daily totals, location-wise comparison + passage timings
     */
    static getWeeklyReport(startDate, endDate, locationId, pageOptions) {
        // Use the dates that were picked; without both, the last 7 days
        const range = calculateDateRange(startDate && endDate ? 'custom' : 'last7days', startDate, endDate);
        if (range.startDate > range.endDate)
            [range.startDate, range.endDate] = [range.endDate, range.startDate];
        if (daysBetween(range.startDate, range.endDate) > MAX_RANGE_DAYS) {
            throw new ReportRangeError(`Pick a range of at most ${MAX_RANGE_DAYS} days, or use the monthly or yearly report.`);
        }
        const locations = db.getLocations().filter((l) => (locationId ? l.id === locationId : true));
        // Generate list of dates between startDate and endDate
        const start = new Date(range.startDate);
        const end = new Date(range.endDate);
        const days = [];
        const curr = new Date(start);
        while (curr <= end) {
            days.push(curr.toISOString().split('T')[0]);
            curr.setDate(curr.getDate() + 1);
        }
        const dailyBreakdown = days.map((day) => {
            const dayData = { date: day, total: 0 };
            locations.forEach((loc) => {
                const counts = CountService.getLocationCount(loc.id, day);
                dayData[loc.name.toLowerCase()] = counts.total;
                dayData.total += counts.total;
            });
            return dayData;
        });
        const locationTotals = locations.map((loc) => {
            const total = days.reduce((sum, day) => {
                return sum + CountService.getLocationCount(loc.id, day).total;
            }, 0);
            return {
                locationId: loc.id,
                locationName: loc.name,
                total,
            };
        });
        const grandTotal = locationTotals.reduce((sum, l) => sum + l.total, 0);
        const passages = ReportService.getPassagesForDateFilter((d) => d >= range.startDate && d <= range.endDate, locationId, pageOptions);
        return {
            type: 'weekly',
            startDate: range.startDate,
            endDate: range.endDate,
            dailyBreakdown,
            locationTotals,
            grandTotal,
            ...passages,
        };
    }
    /**
     * Monthly Report: Daily totals, total trucks per location, combined count, avg daily count + passage timings
     */
    static getMonthlyReport(yearMonth, locationId, pageOptions) {
        const today = new Date();
        const ym = yearMonth || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
        const [yearStr, monthStr] = ym.split('-');
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10);
        const daysInMonth = new Date(year, month, 0).getDate();
        const locations = db.getLocations().filter((l) => (locationId ? l.id === locationId : true));
        const dailyBreakdown = [];
        let grandTotal = 0;
        for (let day = 1; day <= daysInMonth; day++) {
            const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayData = { date: dayStr, dayNumber: day, total: 0 };
            locations.forEach((loc) => {
                const counts = CountService.getLocationCount(loc.id, dayStr);
                dayData[loc.name.toLowerCase()] = counts.total;
                dayData.total += counts.total;
            });
            grandTotal += dayData.total;
            dailyBreakdown.push(dayData);
        }
        const locationTotals = locations.map((loc) => {
            let locTotal = 0;
            for (let day = 1; day <= daysInMonth; day++) {
                const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                locTotal += CountService.getLocationCount(loc.id, dayStr).total;
            }
            return {
                locationId: loc.id,
                locationName: loc.name,
                total: locTotal,
            };
        });
        const averageDailyCount = Math.round((grandTotal / daysInMonth) * 10) / 10;
        const passages = ReportService.getPassagesForDateFilter((d) => d.startsWith(ym), locationId, pageOptions);
        return {
            type: 'monthly',
            month: ym,
            daysInMonth,
            dailyBreakdown,
            locationTotals,
            grandTotal,
            averageDailyCount,
            ...passages,
        };
    }
    /**
     * Yearly Report: Jan-Dec movement, location-wise totals, combined annual count
     */
    static getYearlyReport(yearStr, locationId, pageOptions) {
        const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
        const locations = db.getLocations().filter((l) => (locationId ? l.id === locationId : true));
        const monthNames = [
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December',
        ];
        const monthlyBreakdown = monthNames.map((name, index) => {
            const monthNum = index + 1;
            const monthPrefix = `${year}-${String(monthNum).padStart(2, '0')}`;
            const daysInMonth = new Date(year, monthNum, 0).getDate();
            const monthData = {
                month: name,
                monthIndex: monthNum,
                total: 0,
            };
            locations.forEach((loc) => {
                let locMonthTotal = 0;
                for (let d = 1; d <= daysInMonth; d++) {
                    const dayStr = `${monthPrefix}-${String(d).padStart(2, '0')}`;
                    locMonthTotal += CountService.getLocationCount(loc.id, dayStr).total;
                }
                monthData[loc.name.toLowerCase()] = locMonthTotal;
                monthData.total += locMonthTotal;
            });
            return monthData;
        });
        const locationTotals = locations.map((loc) => {
            const total = monthlyBreakdown.reduce((sum, m) => sum + (m[loc.name.toLowerCase()] || 0), 0);
            return {
                locationId: loc.id,
                locationName: loc.name,
                total,
            };
        });
        const combinedAnnualCount = locationTotals.reduce((sum, l) => sum + l.total, 0);
        const passages = ReportService.getPassagesForDateFilter((d) => d.startsWith(String(year)), locationId, pageOptions);
        return {
            type: 'yearly',
            year,
            monthlyBreakdown,
            locationTotals,
            combinedAnnualCount,
            ...passages,
        };
    }
    /**
     * Export reports to CSV string
     */
    static exportToCsv(reportData) {
        const rows = [];
        if (reportData.type === 'daily') {
            rows.push(`WHEELWASH MONITOR - DAILY REPORT (${reportData.date})`);
            rows.push('');
            rows.push('Location,Automatic Counts,Manual Adjustment,Total Trucks');
            reportData.locations.forEach((l) => {
                rows.push(`"${l.locationName}",${l.automaticCount},${l.manualAdjustment},${l.total}`);
            });
            rows.push(`"COMBINED TOTAL",,,${reportData.totalTrucks}`);
            rows.push('');
            rows.push('Hour,Ghazipur,Okhla,Bhalaswa,Hourly Total');
            reportData.hourlyData.forEach((h) => {
                rows.push(`"${h.hour}",${h.ghazipur},${h.okhla},${h.bhalaswa},${h.total}`);
            });
        }
        else if (reportData.type === 'weekly') {
            rows.push(`WHEELWASH MONITOR - WEEKLY REPORT (${reportData.startDate} to ${reportData.endDate})`);
            rows.push('');
            rows.push('Location,Total Trucks');
            reportData.locationTotals.forEach((l) => {
                rows.push(`"${l.locationName}",${l.total}`);
            });
            rows.push(`"COMBINED TOTAL",${reportData.grandTotal}`);
            rows.push('');
            rows.push('Date,Ghazipur,Okhla,Bhalaswa,Total');
            reportData.dailyBreakdown.forEach((d) => {
                rows.push(`"${d.date}",${d.ghazipur || 0},${d.okhla || 0},${d.bhalaswa || 0},${d.total}`);
            });
        }
        else if (reportData.type === 'monthly') {
            rows.push(`WHEELWASH MONITOR - MONTHLY REPORT (${reportData.month})`);
            rows.push('');
            rows.push(`Total Combined Count,${reportData.grandTotal}`);
            rows.push(`Average Daily Count,${reportData.averageDailyCount}`);
            rows.push('');
            rows.push('Location,Total Trucks');
            reportData.locationTotals.forEach((l) => {
                rows.push(`"${l.locationName}",${l.total}`);
            });
            rows.push('');
            rows.push('Date,Ghazipur,Okhla,Bhalaswa,Daily Total');
            reportData.dailyBreakdown.forEach((d) => {
                rows.push(`"${d.date}",${d.ghazipur || 0},${d.okhla || 0},${d.bhalaswa || 0},${d.total}`);
            });
        }
        else if (reportData.type === 'yearly') {
            rows.push(`WHEELWASH MONITOR - YEARLY REPORT (${reportData.year})`);
            rows.push('');
            rows.push(`Combined Annual Count,${reportData.combinedAnnualCount}`);
            rows.push('');
            rows.push('Location,Annual Total');
            reportData.locationTotals.forEach((l) => {
                rows.push(`"${l.locationName}",${l.total}`);
            });
            rows.push('');
            rows.push('Month,Ghazipur,Okhla,Bhalaswa,Month Total');
            reportData.monthlyBreakdown.forEach((m) => {
                rows.push(`"${m.month}",${m.ghazipur || 0},${m.okhla || 0},${m.bhalaswa || 0},${m.total}`);
            });
        }
        // Append Individual Truck Crossing Timings
        if (reportData.vehiclePassages && reportData.vehiclePassages.length > 0) {
            rows.push('');
            rows.push('--- INDIVIDUAL TRUCK PASSAGE TIMINGS LOG ---');
            rows.push('Passage #,Location,Date,Crossing Time (IST),Full Timestamp,Vehicle Type,Source,Status');
            reportData.vehiclePassages.forEach((p) => {
                rows.push(`${p.passageNumber},"${p.locationName}",${p.date},${p.time},"${p.timestamp}","${p.vehicleType}","${p.detectionSource}","${p.status}"`);
            });
        }
        return rows.join('\n');
    }
    /**
     * Export reports to formatted Excel workbook buffer
     */
    static async exportToExcel(reportData) {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WheelWash Monitor';
        const sheet = workbook.addWorksheet('Report');
        const headerFill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E293B' },
        };
        const headerFont = {
            color: { argb: 'FFFFFFFF' },
            bold: true,
            size: 11,
        };
        if (reportData.type === 'daily') {
            sheet.addRow([`WHEELWASH MONITOR - DAILY REPORT (${reportData.date})`]);
            sheet.addRow([]);
            sheet.addRow(['Location', 'Automatic Counts', 'Manual Adjustment', 'Total Trucks']);
            const headerRow = sheet.getRow(3);
            headerRow.font = headerFont;
            headerRow.fill = headerFill;
            reportData.locations.forEach((l) => {
                sheet.addRow([l.locationName, l.automaticCount, l.manualAdjustment, l.total]);
            });
            sheet.addRow(['COMBINED TOTAL', '', '', reportData.totalTrucks]);
            sheet.addRow([]);
            sheet.addRow(['Hour', 'Ghazipur', 'Okhla', 'Bhalaswa', 'Hourly Total']);
            const hourlyHeader = sheet.getRow(sheet.rowCount);
            hourlyHeader.font = headerFont;
            hourlyHeader.fill = headerFill;
            reportData.hourlyData.forEach((h) => {
                sheet.addRow([h.hour, h.ghazipur, h.okhla, h.bhalaswa, h.total]);
            });
        }
        else if (reportData.type === 'weekly') {
            sheet.addRow([`WHEELWASH MONITOR - WEEKLY REPORT (${reportData.startDate} to ${reportData.endDate})`]);
            sheet.addRow([]);
            sheet.addRow(['Location', 'Total Trucks']);
            const h1 = sheet.getRow(3);
            h1.font = headerFont;
            h1.fill = headerFill;
            reportData.locationTotals.forEach((l) => {
                sheet.addRow([l.locationName, l.total]);
            });
            sheet.addRow(['COMBINED TOTAL', reportData.grandTotal]);
            sheet.addRow([]);
            sheet.addRow(['Date', 'Ghazipur', 'Okhla', 'Bhalaswa', 'Total']);
            const h2 = sheet.getRow(sheet.rowCount);
            h2.font = headerFont;
            h2.fill = headerFill;
            reportData.dailyBreakdown.forEach((d) => {
                sheet.addRow([d.date, d.ghazipur || 0, d.okhla || 0, d.bhalaswa || 0, d.total]);
            });
        }
        else if (reportData.type === 'monthly') {
            sheet.addRow([`WHEELWASH MONITOR - MONTHLY REPORT (${reportData.month})`]);
            sheet.addRow([`Total Combined Count: ${reportData.grandTotal}`]);
            sheet.addRow([`Average Daily Count: ${reportData.averageDailyCount}`]);
            sheet.addRow([]);
            sheet.addRow(['Location', 'Total Trucks']);
            const h1 = sheet.getRow(5);
            h1.font = headerFont;
            h1.fill = headerFill;
            reportData.locationTotals.forEach((l) => {
                sheet.addRow([l.locationName, l.total]);
            });
            sheet.addRow([]);
            sheet.addRow(['Date', 'Ghazipur', 'Okhla', 'Bhalaswa', 'Daily Total']);
            const h2 = sheet.getRow(sheet.rowCount);
            h2.font = headerFont;
            h2.fill = headerFill;
            reportData.dailyBreakdown.forEach((d) => {
                sheet.addRow([d.date, d.ghazipur || 0, d.okhla || 0, d.bhalaswa || 0, d.total]);
            });
        }
        else if (reportData.type === 'yearly') {
            sheet.addRow([`WHEELWASH MONITOR - YEARLY REPORT (${reportData.year})`]);
            sheet.addRow([`Combined Annual Count: ${reportData.combinedAnnualCount}`]);
            sheet.addRow([]);
            sheet.addRow(['Location', 'Annual Total']);
            const h1 = sheet.getRow(4);
            h1.font = headerFont;
            h1.fill = headerFill;
            reportData.locationTotals.forEach((l) => {
                sheet.addRow([l.locationName, l.total]);
            });
            sheet.addRow([]);
            sheet.addRow(['Month', 'Ghazipur', 'Okhla', 'Bhalaswa', 'Month Total']);
            const h2 = sheet.getRow(sheet.rowCount);
            h2.font = headerFont;
            h2.fill = headerFill;
            reportData.monthlyBreakdown.forEach((m) => {
                sheet.addRow([m.month, m.ghazipur || 0, m.okhla || 0, m.bhalaswa || 0, m.total]);
            });
        }
        // Auto-fit column widths
        sheet.columns.forEach((column) => {
            column.width = 20;
        });
        // 2nd Sheet: Individual Truck Passage Timings
        const passageSheet = workbook.addWorksheet('Truck Passage Timings');
        passageSheet.columns = [
            { header: 'Passage #', key: 'num', width: 14 },
            { header: 'Location', key: 'loc', width: 20 },
            { header: 'Date', key: 'date', width: 16 },
            { header: 'Crossing Time (IST)', key: 'time', width: 22 },
            { header: 'Full Timestamp', key: 'timestamp', width: 24 },
            { header: 'Vehicle Classification', key: 'type', width: 28 },
            { header: 'Detection Source', key: 'source', width: 22 },
            { header: 'Wash Status', key: 'status', width: 20 },
        ];
        const passHeader = passageSheet.getRow(1);
        passHeader.font = headerFont;
        passHeader.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF065F46' }, // Emerald 800
        };
        if (reportData.vehiclePassages && reportData.vehiclePassages.length > 0) {
            reportData.vehiclePassages.forEach((p) => {
                passageSheet.addRow({
                    num: p.passageNumber,
                    loc: p.locationName,
                    date: p.date,
                    time: p.time,
                    timestamp: p.timestamp,
                    type: p.vehicleType,
                    source: p.detectionSource,
                    status: p.status,
                });
            });
        }
        else {
            passageSheet.addRow({
                num: '-',
                loc: 'No passages recorded for this period',
                date: '-',
                time: '-',
                timestamp: '-',
                type: '-',
                source: '-',
                status: '-',
            });
        }
        const buffer = await workbook.xlsx.writeBuffer();
        return Buffer.from(buffer);
    }
}
