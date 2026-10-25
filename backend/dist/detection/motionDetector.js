import { logger } from '../utils/logger.js';
export class MotionDetector {
    locationId;
    locationName;
    config;
    stage = 'IDLE';
    classification = 'NONE';
    zoneEnteredAt = 0;
    lastPassageAt = 0;
    lastTruckDetectedAt = 0;
    truckEvidenceCount = 0;
    zoneClearedAt = 0;
    confidence = 0;
    onVehicleDetectedCallback;
    constructor(locationId, locationName, config, onVehicleDetected) {
        this.locationId = locationId;
        this.locationName = locationName;
        const minDur = config.minDurationMs && config.minDurationMs <= 600 ? config.minDurationMs : 400;
        this.config = Object.assign({
            minTruckAreaPercent: 30,
            cooldownSeconds: 4,
            sensitivity: 60,
            minDurationMs: 400,
            direction: 'any',
            roi: { x: 20, y: 35, width: 60, height: 45 },
        }, config);
        if (minDur) {
            this.config.minDurationMs = minDur;
        }
        if (this.config.minDurationMs > 600) {
            this.config.minDurationMs = 400;
        }
        this.onVehicleDetectedCallback = onVehicleDetected;
    }
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        if (this.config.minDurationMs > 600) {
            this.config.minDurationMs = 400;
        }
        logger.info(`Updated detection config for ${this.locationName}:`, this.config);
    }
    getConfig() {
        return { ...this.config };
    }
    getStage() {
        return this.stage;
    }
    getClassification() {
        return this.classification;
    }
    getConfidence() {
        return this.confidence;
    }
    /**
     * Process frame motion with Human vs Heavy Truck classification (virtual demo feed):
     * @param motionScore 0-100 overall optical motion
     * @param spatialMassPercent 0-100 estimated spatial bounding area in ROI
     * @param isHumanProfile boolean flag if aspect ratio is narrow/tall pedestrian
     */
    processMotion(motionScore, spatialMassPercent = motionScore, isHumanProfile = false) {
        const threshold = this.config.sensitivity || 60;
        const isMotionSignificant = motionScore >= threshold;
        const minTruckMass = this.config.minTruckAreaPercent || 30;
        // Strict Human vs Heavy Truck Classification:
        // A Human/Worker is characterized by:
        // 1) Explicit isHumanProfile flag (tall narrow aspect ratio), OR
        // 2) Significant motion but spatial mass too small for a commercial vehicle (< minTruckMass)
        const isHumanDetected = isMotionSignificant && (isHumanProfile || spatialMassPercent < minTruckMass);
        // A Heavy Truck is characterized by:
        // Broad, heavy mass (>= minTruckMass) AND NOT having a human profile
        const isTruckDetected = isMotionSignificant && !isHumanProfile && spatialMassPercent >= minTruckMass;
        const confidence = isHumanDetected
            ? Math.min(96, Math.max(80, Math.round(95 - spatialMassPercent * 0.5)))
            : Math.min(99, Math.max(85, Math.round(82 + spatialMassPercent * 0.16)));
        return this.step(isTruckDetected, isHumanDetected, confidence, `Mass: ${spatialMassPercent}%, Motion: ${motionScore}%`);
    }
    /**
     * Process an AI object-detection result (YOLO26) for a live camera frame.
     * Only a detected truck in the ROI can ever advance the counter; people are always ignored.
     */
    processDetection(scene) {
        const isTruckDetected = scene.truckDetected;
        const isHumanDetected = !scene.truckDetected && scene.humanDetected;
        return this.step(isTruckDetected, isHumanDetected, scene.confidence, `YOLO confidence: ${scene.confidence}%`);
    }
    /**
     * Passage state machine: IDLE -> ENTERED_ZONE -> IN_PASSAGE (+1) -> COOLDOWN -> IDLE.
     * A passage is counted exactly once, and the zone must stay free of trucks for
     * cooldownSeconds before the next truck can be counted.
     */
    step(isTruckDetected, isHumanDetected, detectedConfidence, logContext) {
        const now = Date.now();
        let triggered = false;
        if (isHumanDetected) {
            this.classification = 'HUMAN_IGNORED';
            this.confidence = detectedConfidence;
        }
        else if (isTruckDetected) {
            this.classification = 'TRUCK_VERIFIED';
            this.confidence = detectedConfidence;
        }
        else if (this.stage === 'IN_PASSAGE') {
            this.classification = 'TRUCK_VERIFIED';
        }
        else if (this.stage === 'COOLDOWN') {
            this.classification = 'TRUCK_VERIFIED';
        }
        else {
            this.classification = 'NONE';
            this.confidence = 0;
        }
        switch (this.stage) {
            case 'IDLE':
                if (isHumanDetected) {
                    // Human/worker in zone: STRICT FILTER - Never trigger entry or increment counter
                    this.stage = 'IDLE';
                    this.truckEvidenceCount = 0;
                    logger.debug(`[PEDESTRIAN FILTER] Human filtered at ${this.locationName} (${logContext}) - Counter Ignored`);
                }
                else if (isTruckDetected) {
                    this.stage = 'ENTERED_ZONE';
                    this.zoneEnteredAt = now;
                    this.lastTruckDetectedAt = now;
                    this.truckEvidenceCount = 1;
                }
                break;
            case 'ENTERED_ZONE':
                if (isHumanDetected) {
                    // If human profile is detected during entry, cancel truck entry immediately!
                    this.stage = 'IDLE';
                    this.truckEvidenceCount = 0;
                    logger.debug(`[PEDESTRIAN OVERRIDE] Entered zone cancelled by pedestrian detection at ${this.locationName}`);
                }
                else if (isTruckDetected) {
                    this.lastTruckDetectedAt = now;
                    this.truckEvidenceCount++;
                    const duration = now - this.zoneEnteredAt;
                    // Trigger confirmed count when duration reached and at least 2 consecutive positive frames
                    if (duration >= this.config.minDurationMs && this.truckEvidenceCount >= 2) {
                        this.stage = 'IN_PASSAGE';
                        this.lastPassageAt = now;
                        triggered = true;
                        logger.info(`[TRUCK VERIFIED (+1)] Heavy truck passage confirmed at ${this.locationName} (Duration: ${duration}ms, ${logContext})`);
                        if (this.onVehicleDetectedCallback) {
                            this.onVehicleDetectedCallback(this.locationId);
                        }
                    }
                }
                else {
                    // Motion momentarily dipped. Allow 800ms grace window before dropping
                    const timeSinceTruck = now - this.lastTruckDetectedAt;
                    if (timeSinceTruck > 800) {
                        this.stage = 'IDLE';
                        this.truckEvidenceCount = 0;
                    }
                }
                break;
            case 'IN_PASSAGE':
                if (isTruckDetected) {
                    this.lastTruckDetectedAt = now;
                }
                else {
                    const timeSinceMotion = now - this.lastTruckDetectedAt;
                    if (timeSinceMotion > 400) {
                        this.stage = 'COOLDOWN';
                        this.zoneClearedAt = now;
                    }
                }
                break;
            case 'COOLDOWN':
                if (isTruckDetected) {
                    this.zoneClearedAt = now;
                }
                else {
                    const clearDuration = (now - this.zoneClearedAt) / 1000;
                    if (clearDuration >= this.config.cooldownSeconds) {
                        this.stage = 'IDLE';
                        this.classification = 'NONE';
                        this.truckEvidenceCount = 0;
                    }
                }
                break;
        }
        return {
            stage: this.stage,
            triggered,
            classification: this.classification,
            confidence: this.confidence,
        };
    }
    reset() {
        this.stage = 'IDLE';
        this.classification = 'NONE';
        this.zoneEnteredAt = 0;
        this.lastTruckDetectedAt = 0;
        this.truckEvidenceCount = 0;
        this.zoneClearedAt = 0;
    }
}
