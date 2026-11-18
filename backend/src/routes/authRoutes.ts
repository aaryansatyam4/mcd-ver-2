import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

router.post('/login', AuthController.login);
router.post('/logout', authenticateToken, AuthController.logout);
router.get('/me', authenticateToken, AuthController.me);
router.post('/refresh', authenticateToken, AuthController.refresh);
router.post('/change-password', authenticateToken, AuthController.changePassword);

export default router;
