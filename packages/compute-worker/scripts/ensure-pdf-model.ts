import { ensureModel } from '../src/inference/pdf/model';

const modelPath = await ensureModel();
console.log(`PDF layout model is ready at ${modelPath}`);
