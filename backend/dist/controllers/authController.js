import bcrypt from 'bcryptjs';
import { db } from '../database/excelDb.js';
import { generateToken } from '../utils/jwtUtils.js';
import { getKolkataTimestamp } from '../utils/dateUtils.js';
import { AuditService } from '../services/auditService.js';
export class AuthController {
    static async login(req, res) {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                res.status(400).json({ error: 'Username and password are required.' });
                return;
            }
            const user = db.getUserByUsername(username);
            if (!user) {
                res.status(401).json({ error: 'Invalid username or password.' });
                return;
            }
            if (user.active !== 1) {
                res.status(403).json({ error: 'This user account is disabled. Contact system administrator.' });
                return;
            }
            const passwordMatches = bcrypt.compareSync(password, user.password_hash);
            if (!passwordMatches) {
                AuditService.log(user.id, 'LOGIN_FAILED', `Failed login attempt for user: ${username}`);
                res.status(401).json({ error: 'Invalid username or password.' });
                return;
            }
            // Update last login
            const now = getKolkataTimestamp();
            db.updateUser(user.id, { last_login: now });
            AuditService.log(user.id, 'LOGIN_SUCCESS', `User ${username} logged in successfully`);
            const token = generateToken({
                userId: user.id,
                username: user.username,
                role: user.role,
                assignedLocationId: user.assigned_location_id,
            });
            const assignedLoc = user.assigned_location_id
                ? db.getLocationById(user.assigned_location_id)
                : null;
            const safeUser = {
                id: user.id,
                username: user.username,
                role: user.role,
                assigned_location_id: user.assigned_location_id,
                assigned_location_name: assignedLoc ? assignedLoc.name : null,
                active: user.active,
                must_change_password: user.must_change_password,
                created_at: user.created_at,
                last_login: now,
            };
            res.json({
                message: 'Login successful',
                token,
                user: safeUser,
            });
        }
        catch (err) {
            res.status(500).json({ error: err.message || 'Login failed.' });
        }
    }
    /**
     * Swap a still-valid token for a fresh one. Open pages call this regularly, so a camera PC that
     * streams for days stays signed in, while a browser closed for longer than the token lifetime
     * must log in again. The new token is built from the current user record (role, location), and
     * authenticateToken has already refused disabled or deleted users.
     */
    static async refresh(req, res) {
        const user = req.user;
        const token = generateToken({
            userId: user.id,
            username: user.username,
            role: user.role,
            assignedLocationId: user.assigned_location_id,
        });
        res.json({ token });
    }
    static async logout(req, res) {
        if (req.user) {
            AuditService.log(req.user.id, 'LOGOUT', `User ${req.user.username} logged out`);
        }
        res.json({ message: 'Logged out successfully.' });
    }
    static async me(req, res) {
        if (!req.user) {
            res.status(401).json({ error: 'Unauthorized.' });
            return;
        }
        const assignedLoc = req.user.assigned_location_id
            ? db.getLocationById(req.user.assigned_location_id)
            : null;
        const safeUser = {
            id: req.user.id,
            username: req.user.username,
            role: req.user.role,
            assigned_location_id: req.user.assigned_location_id,
            assigned_location_name: assignedLoc ? assignedLoc.name : null,
            active: req.user.active,
            must_change_password: req.user.must_change_password,
            created_at: req.user.created_at,
            last_login: req.user.last_login,
        };
        res.json({ user: safeUser });
    }
    static async changePassword(req, res) {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Unauthorized.' });
                return;
            }
            const { currentPassword, newPassword } = req.body;
            if (!newPassword || newPassword.length < 6) {
                res.status(400).json({ error: 'New password must be at least 6 characters long.' });
                return;
            }
            // If user is forced to change password on first login, check current password if provided
            if (currentPassword) {
                const isCurrentValid = bcrypt.compareSync(currentPassword, req.user.password_hash);
                if (!isCurrentValid) {
                    res.status(400).json({ error: 'Current password does not match.' });
                    return;
                }
            }
            const newHash = bcrypt.hashSync(newPassword, 10);
            db.updateUser(req.user.id, {
                password_hash: newHash,
                must_change_password: 0,
            });
            AuditService.log(req.user.id, 'PASSWORD_CHANGED', `User ${req.user.username} changed password`);
            res.json({ message: 'Password changed successfully.' });
        }
        catch (err) {
            res.status(500).json({ error: err.message || 'Failed to change password.' });
        }
    }
}
