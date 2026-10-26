import { Response } from 'express';
import { ReportRangeError, ReportService, parsePassagePageOptions } from '../services/reportService.js';
import { getKolkataDateString } from '../utils/dateUtils.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

export class ReportController {
  public static async getDaily(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user!;
      const dateStr = (req.query.date as string) || getKolkataDateString();
      const locationId = user.role === 'operator' && user.assigned_location_id
        ? user.assigned_location_id
        : req.query.locationId
        ? parseInt(String(req.query.locationId), 10)
        : undefined;

      const report = ReportService.getDailyReport(dateStr, locationId, parsePassagePageOptions(req.query));
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate daily report.' });
    }
  }

  public static async getWeekly(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user!;
      const startDate = req.query.startDate as string;
      const endDate = req.query.endDate as string;
      const locationId = user.role === 'operator' && user.assigned_location_id
        ? user.assigned_location_id
        : req.query.locationId
        ? parseInt(String(req.query.locationId), 10)
        : undefined;

      const report = ReportService.getWeeklyReport(startDate, endDate, locationId, parsePassagePageOptions(req.query));
      res.json(report);
    } catch (err: any) {
      res.status(err instanceof ReportRangeError ? 400 : 500).json({ error: err.message || 'Failed to generate weekly report.' });
    }
  }

  public static async getMonthly(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user!;
      const month = req.query.month as string; // YYYY-MM
      const locationId = user.role === 'operator' && user.assigned_location_id
        ? user.assigned_location_id
        : req.query.locationId
        ? parseInt(String(req.query.locationId), 10)
        : undefined;

      const report = ReportService.getMonthlyReport(month, locationId, parsePassagePageOptions(req.query));
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate monthly report.' });
    }
  }

  public static async getYearly(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user!;
      const year = req.query.year as string; // YYYY
      const locationId = user.role === 'operator' && user.assigned_location_id
        ? user.assigned_location_id
        : req.query.locationId
        ? parseInt(String(req.query.locationId), 10)
        : undefined;

      const report = ReportService.getYearlyReport(year, locationId, parsePassagePageOptions(req.query));
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate yearly report.' });
    }
  }

  public static async exportReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user!;
      const format = ((req.query.format as string) || 'csv').toLowerCase();
      const type = (req.query.type as string) || 'daily';
      const date = req.query.date as string;
      const startDate = req.query.startDate as string;
      const endDate = req.query.endDate as string;
      const month = req.query.month as string;
      const year = req.query.year as string;

      const locationId = user.role === 'operator' && user.assigned_location_id
        ? user.assigned_location_id
        : req.query.locationId
        ? parseInt(String(req.query.locationId), 10)
        : undefined;

      let reportData: any;
      if (type === 'weekly') {
        reportData = ReportService.getWeeklyReport(startDate, endDate, locationId);
      } else if (type === 'monthly') {
        reportData = ReportService.getMonthlyReport(month, locationId);
      } else if (type === 'yearly') {
        reportData = ReportService.getYearlyReport(year, locationId);
      } else {
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
    } catch (err: any) {
      res.status(err instanceof ReportRangeError ? 400 : 500).json({ error: err.message || 'Failed to export report.' });
    }
  }
}
