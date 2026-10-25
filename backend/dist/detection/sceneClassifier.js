const area = (b) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
function intersection(a, b) {
    return area({
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
        x2: Math.min(a.x2, b.x2),
        y2: Math.min(a.y2, b.y2),
    });
}
function iou(a, b) {
    const inter = intersection(a, b);
    const union = area(a) + area(b) - inter;
    return union > 0 ? inter / union : 0;
}
/**
 * Turn raw YOLO detections into a Truck vs Human decision for the wheel-wash ROI.
 *
 * - Only boxes that overlap the ROI matter.
 * - A person NEVER counts. A person alone in the ROI is reported as human (ignored).
 * - A truck counts even if people (driver, washer) are also in the ROI.
 * - If a "truck" box is essentially the same box as a more confident "person" box,
 *   it is a misclassified person standing close to the camera, so it is dropped.
 */
export function analyzeDetections(result, roi, opts) {
    const minOverlap = opts.minRoiOverlap ?? 0.3;
    const minCoverage = opts.minTruckRoiCoverage ?? 0.1;
    const { width, height } = result;
    const roiBox = {
        x1: (roi.x / 100) * width,
        y1: (roi.y / 100) * height,
        x2: ((roi.x + roi.width) / 100) * width,
        y2: ((roi.y + roi.height) / 100) * height,
    };
    const roiArea = area(roiBox);
    const overlapsRoi = (b) => {
        const smaller = Math.min(area(b), roiArea);
        return smaller > 0 && intersection(b, roiBox) / smaller >= minOverlap;
    };
    const people = [];
    const trucks = [];
    for (const d of result.detections) {
        const [x1, y1, x2, y2] = d.bbox;
        const box = { x1, y1, x2, y2 };
        const name = d.class_name.toLowerCase();
        if (name === 'person' && d.confidence >= opts.personMinConfidence) {
            people.push({ box, confidence: d.confidence });
        }
        else if (opts.vehicleClasses.includes(name) && d.confidence >= opts.truckMinConfidence) {
            trucks.push({ box, confidence: d.confidence });
        }
    }
    const objects = [];
    const toPercentBox = (b) => ({
        x: (b.x1 / width) * 100,
        y: (b.y1 / height) * 100,
        width: ((b.x2 - b.x1) / width) * 100,
        height: ((b.y2 - b.y1) / height) * 100,
    });
    let bestTruck = 0;
    for (const t of trucks) {
        const isReallyPerson = people.some((p) => p.confidence >= t.confidence && iou(p.box, t.box) >= 0.5);
        const inRoi = overlapsRoi(t.box) && intersection(t.box, roiBox) / roiArea >= minCoverage;
        const counted = inRoi && !isReallyPerson;
        if (counted)
            bestTruck = Math.max(bestTruck, t.confidence);
        objects.push({ label: 'truck', confidence: Math.round(t.confidence * 100), box: toPercentBox(t.box), inRoi: counted });
    }
    let bestPerson = 0;
    for (const p of people) {
        const inRoi = overlapsRoi(p.box);
        if (inRoi)
            bestPerson = Math.max(bestPerson, p.confidence);
        objects.push({ label: 'person', confidence: Math.round(p.confidence * 100), box: toPercentBox(p.box), inRoi });
    }
    const truckDetected = bestTruck > 0;
    const humanDetected = !truckDetected && bestPerson > 0;
    return {
        truckDetected,
        humanDetected,
        confidence: Math.round((truckDetected ? bestTruck : bestPerson) * 100),
        objects,
    };
}
