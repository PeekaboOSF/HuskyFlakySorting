import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ghostRouter from "./ghost";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ghostRouter);

export default router;
