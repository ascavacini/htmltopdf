import express from "express";
import puppeteer from "puppeteer";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

let browserPromise = null;
let activeJob = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  return browserPromise;
}

async function closePageSafely(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch {}
}

async function cancelActiveJob(reason = "Cancelled by newer request") {
  if (!activeJob) return;

  const job = activeJob;
  activeJob = null;

  try {
    job.cancelled = true;
  } catch {}

  await closePageSafely(job.page);

  try {
    if (!job.res.headersSent) {
      job.res.status(409).json({
        error: reason
      });
    }
  } catch {}
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/html-to-pdf", async (req, res) => {
  const {
    html,
    format = "A4",
    landscape = false,
    printBackground = true,
    margin = {
      top: "10mm",
      right: "10mm",
      bottom: "10mm",
      left: "10mm"
    },
    request_id
  } = req.body || {};

  if (!html || typeof html !== "string") {
    return res.status(400).json({
      error: "Campo 'html' é obrigatório e deve ser string."
    });
  }

  // Chegou uma nova chamada? mata a anterior
  if (activeJob) {
    await cancelActiveJob("Cancelled because a newer request arrived");
  }

  const jobId = request_id || crypto.randomUUID();
  let page = null;

  const job = {
    id: jobId,
    page: null,
    res,
    cancelled: false
  };

  activeJob = job;

  req.on("close", async () => {
    if (activeJob?.id === jobId) {
      await cancelActiveJob("Client disconnected");
    }
  });

  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    job.page = page;

    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000
    });

    if (job.cancelled) {
      throw new Error("Job cancelled before PDF generation");
    }

    const pdf = await page.pdf({
      format,
      landscape,
      printBackground,
      margin
    });

    if (job.cancelled) {
      throw new Error("Job cancelled after PDF generation");
    }

    if (activeJob?.id === jobId) {
      activeJob = null;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="arquivo.pdf"');
    res.setHeader("Content-Length", pdf.length);

    return res.status(200).send(pdf);
  } catch (error) {
    if (activeJob?.id === jobId) {
      activeJob = null;
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error: error?.message || "Falha ao gerar PDF"
      });
    }
  } finally {
    await closePageSafely(page);
  }
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${port}`);
});