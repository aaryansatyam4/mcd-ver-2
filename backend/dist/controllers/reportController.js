import { ReportRangeError, ReportService, parsePassagePageOptions } from '../services/reportService.js';
import { getKolkataDateString } from '../utils/dateUtils.js';
export class ReportController {
    static async getDaily(req, res) {
        try {
            const user = req.user;
            const dateStr = req.query.date || getKolkataDateString();
            const locationId = user.role === 'operator' && user.assigned_location_id
                ? user.assigned_location_id
                : req.query.locationId
                    ? parseInt(String(req.query.locationId), 10)
                    : undefined;
            const report = ReportService.getDailyReport(dateStr, locationId, parsePassagePageOptions(req.query));
            res.json(report);
        }
        catch (err) {
            res.status(500).json({ error: err.message || 'Failed to generate daily report.' });
        }
    }
    static async getWeekly(req, res) {
        try {
            const user = req.user;
            const startDate = req.query.startDate;
            const endDate = req.query.endDate;
            const locationId = user.role === 'operator' && user.assigned_location_id
                ? user.assigned_location_id
                : req.query.locationId
                    ? parseInt(String(req.query.locationId), 10)
                    : undefined;
            const report = ReportService.getWeeklyReport(startDate, endDate, locationId, parsePassagePageOptions(req.query));
            res.json(report);
        }
        catch (err) {
            res.status(err instanceof ReportRangeError ? 400 : 500).json({ error: err.message || 'Failed to generate weekly report.' });
        }
    }
    static async getMonthly(req, res) {
        try {
            const user = req.user;
            const month = req.query.month; // YYYY-MM
            const locationId = user.role === 'operator' && user.assigned_location_id
                ? user.assigned_location_id
                : req.query.locationId
                    ? parseInt(String(req.query.locationId), 10)
                    : undefined;
            const report = ReportService.getMonthlyReport(month, locationId, parsePassagePageOptions(req.query));
            res.json(report);
        }
        catch (err) {
            res.status(500).json({ error: err.message || 'Failed to generate monthly report.' });
        }
    }
    static async getYearly(req, res) {
        try {
            const user = req.user;
            const year = req.query.year; // YYYY
            const locationId = user.role === 'operator' && user.assigned_location_id
                ? user.assigned_location_id
                : req.query.locationId
                    ? parseInt(String(req.query.locationId), 10)
                    : undefined;
            const report = ReportService.getYearlyReport(year, locationId, parsePassagePageOptions(req.query));
            res.json(report);
        }
        catch (err) {
            res.status(500).json({ error: err.message || 'Failed to generate yearly report.' });
        }
    }
    static async exportReport(req, res) {
        try {
            const user = req.user;
            const format = (req.query.format || 'csv').toLowerCase();
            const type = req.query.type || 'daily';
            const date = req.query.date;
            const startDate = req.query.startDate;
            const endDate = req.query.endDate;
            const month = req.query.month;
            const year = req.query.year;
            const locationId = user.role === 'operator' && user.assigned_location_id
                ? user.assigned_location_id
                : req.query.locationId
                    ? parseInt(String(req.query.locationId), 10)
                    : undefined;
            let reportData;
            if (type === 'weekly') {
                reportData = ReportService.getWeeklyReport(startDate, endDate, locationId);
            }
            else if (type === 'monthly') {
                reportData = ReportService.getMonthlyReport(month, locationId);
            }
            else if (type === 'yearly') {
                reportData = ReportService.getYearlyReport(year, locationId);
            }
            else {
                reportData = ReportService.getDailyReport(date, locationId);
            }
            const filename = `WheelWash_${type}_report_${getKolkataDateString()}`;
            if (format === 'excel' || format === 'xlsx') {
                const buffer = await ReportService.exportToExcel(reportData);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
                res.send(buffer);
                return;
            }
            // Default CSV
            const csvContent = ReportService.exportToCsv(reportData);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            res.send(csvContent);
        }
        catch (err) {
            res.status(err instanceof ReportRangeError ? 400 : 500).json({ error: err.message || 'Failed to export report.' });
        }
    }
}
