import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
// @ts-ignore
import { PDFParse } from 'pdf-parse';
import { prisma } from '../../db/client.js';
import { SecurityEngine } from '../../common/security.js';
import { ServiceConfig } from '../../config/serviceConfig.js';

export interface DocumentAnalysisResult {
  documentType: string;
  applicantName?: string;
  idNumber?: string;
  address?: string;
  confidenceScore: number;
  extractedFields: Record<string, any>;
  summary: string;
}

export interface ServiceMatchResult {
  isRecognized: boolean;
  bestMatch: {
    serviceId: string;
    serviceKey: string;
    serviceName: string;
    category: string;
    confidence: number;
    reasoning: string;
    requiredDocuments: Array<{
      documentType: string;
      title: string;
      description?: string;
      isMandatory: boolean;
    }>;
    firstStage: {
      name: string;
      departmentCode: string;
      slaDays: number;
    };
  };
  alternativeMatches: Array<{
    serviceKey: string;
    serviceName: string;
    confidence: number;
  }>;
}

export class DocumentAnalyzer {
  private static getGeminiClient(): GoogleGenAI | null {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
  }

  /**
   * Deterministic Sovereign Document Extractor (Offline / Reliable Fallback)
   */
  private static parseSovereign(text: string, filename?: string): DocumentAnalysisResult {
    const lower = `${filename ?? ''} ${text}`.toLowerCase();

    let docType = 'unrecognized_document';
    let name: string | undefined;
    let idNumber: string | undefined;
    let address: string | undefined;
    let confidence = 0.15;

    // 1. Identify Document Type - Priority 1: Primary Statutory Application Documents
    if (
      lower.includes('gun license') ||
      lower.includes('arms license') ||
      lower.includes('form a-1') ||
      lower.includes('arms act') ||
      lower.includes('firearm license') ||
      lower.includes('arms permit') ||
      lower.includes('npb firearm') ||
      (lower.includes('fresh arms') && lower.includes('license')) ||
      ((lower.includes('gun') || lower.includes('firearm') || lower.includes('weapon') || lower.includes('pistol') || lower.includes('revolver')) &&
        (lower.includes('license') || lower.includes('magistrate') || lower.includes('licensing authority')))
    ) {
      docType = 'arms_license_application';
      confidence = 0.98;
    } else if (
      lower.includes('passport application') ||
      lower.includes('reissue of passport') ||
      lower.includes('passport reissue') ||
      lower.includes('tatkaal passport') ||
      (lower.includes('passport') && (lower.includes('republic of india') || lower.includes('reissue') || lower.includes('consular') || lower.includes('travel document')))
    ) {
      docType = 'passport';
      confidence = 0.95;
      const pMatch = text.match(/\b[A-Z][0-9]{7}\b/);
      if (pMatch) idNumber = pMatch[0];
    } else if (
      lower.includes('trade license') ||
      lower.includes('commercial license') ||
      lower.includes('shop and establishment') ||
      lower.includes('business operation license') ||
      lower.includes('gumasta')
    ) {
      docType = 'trade_license_application';
      confidence = 0.95;
    } else if (
      lower.includes('borewell') ||
      lower.includes('groundwater') ||
      lower.includes('ground water') ||
      lower.includes('hydro-geological') ||
      lower.includes('drilling permission') ||
      lower.includes('water table')
    ) {
      docType = 'borewell_clearance_application';
      confidence = 0.95;
    }
    // Priority 2: Supporting Proof Documents (Only if not a primary application form)
    else if (
      (lower.includes('electricity') || lower.includes('kseb') || lower.includes('utility bill') || lower.includes('consumer no') || lower.includes('power distribution')) &&
      !lower.includes('application for grant') &&
      !lower.includes('statutory application')
    ) {
      docType = 'electricity_bill';
      confidence = 0.9;
      const conMatch = text.match(/\b(?:consumer|ca|acc|no)[^\d]*(\d{6,12})\b/i);
      if (conMatch) idNumber = conMatch[1];
    } else if (lower.includes('aadhaar') || lower.includes('uidai') || lower.includes('unique identification')) {
      docType = 'aadhaar_card';
      confidence = 0.95;
      const uidMatch = text.match(/\b\d{4}\s\d{4}\s\d{4}\b/) || text.match(/\b\d{12}\b/);
      if (uidMatch) idNumber = uidMatch[0];
    } else if (lower.includes('deed') || lower.includes('patta') || lower.includes('property tax')) {
      docType = 'property_tax_receipt';
      confidence = 0.85;
    } else if (lower.includes('fire safety') || lower.includes('fire extinguisher') || lower.includes('evacuation map')) {
      docType = 'fire_safety_plan';
      confidence = 0.85;
    } else if (lower.includes('character certificate') || lower.includes('police clearance') || lower.includes('pcc')) {
      docType = 'character_certificate';
      confidence = 0.85;
    }

    // 2. Extract Name heuristics - Specific applicant label priority
    const specificNameMatch = text.match(/(?:Full Legal Name(?:\s+of\s+Applicant)?|Applicant Name|Full Name|Name of Applicant|Name of Citizen)[\s:]+([^\r\n]{2,40})/i);
    const genericNameMatch = text.match(/(?:Name|Shri|Mr\.|Ms\.)[\s:]+([^\r\n]{2,40})/i);

    if (specificNameMatch) {
      const candidate = specificNameMatch[1].trim();
      if (!/identification|particulars|declaration|section|details|address/i.test(candidate)) {
        name = candidate.replace(/[^A-Za-z\s.]/g, '').trim();
      }
    }
    if (!name && genericNameMatch) {
      const candidate = genericNameMatch[1].trim();
      if (!/identification|particulars|declaration|section|details|address/i.test(candidate)) {
        name = candidate.replace(/[^A-Za-z\s.]/g, '').trim();
      }
    }

    // 3. Extract Address heuristics (no invented fallback addresses)
    const addrMatch = text.match(/(?:Residential Address|Permanent Address|Premises Address|Address)[\s:]+([^\r\n]{5,100})/i);
    if (addrMatch) address = addrMatch[1].trim();

    const isRecognized = docType !== 'unrecognized_document';

    return {
      documentType: docType,
      applicantName: name,
      idNumber,
      address,
      confidenceScore: confidence,
      extractedFields: {
        applicantName: name,
        maskedIdNumber: idNumber ? SecurityEngine.maskPii(idNumber) : undefined,
        address,
        documentType: docType,
        isRecognized,
      },
      summary: isRecognized
        ? `Document successfully classified as "${docType}" with extracted applicant identity.`
        : 'Uploaded file could not be verified as a valid statutory government application.',
    };
  }

  /**
   * Analyzes document content, OCR text, or file notes
   */
  static async analyzeDocument(text: string, filename?: string): Promise<DocumentAnalysisResult> {
    const gemini = this.getGeminiClient();

    if (gemini && text.length > 20) {
      try {
        const prompt = `Analyze this government application document text. Extract structured metadata:
Text:
${text}
Filename: ${filename ?? 'N/A'}`;

        const response = await gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: {
            systemInstruction: `You are an OCR and Document Understanding Engine for government services.
Return strictly JSON matching this structure:
{
  "documentType": "string (e.g. aadhaar_card, electricity_bill, passport, fire_safety_plan, character_certificate, property_tax_receipt)",
  "applicantName": "string or null",
  "idNumber": "string or null",
  "address": "string or null",
  "confidenceScore": 0.95,
  "summary": "1 sentence extraction summary"
}`,
            responseMimeType: 'application/json',
          },
        });

        const raw = typeof (response as any).text === 'function' ? (response as any).text() : (response as any).text;
        if (raw && typeof raw === 'string') {
          const parsed = JSON.parse(raw);
          return {
            documentType: parsed.documentType || 'general_document',
            applicantName: parsed.applicantName,
            idNumber: parsed.idNumber,
            address: parsed.address,
            confidenceScore: parsed.confidenceScore || 0.9,
            extractedFields: { ...parsed, idNumber: parsed.idNumber ? SecurityEngine.maskPii(parsed.idNumber) : undefined },
            summary: parsed.summary || 'Document analyzed via Gemini GenAI.',
          };
        }
      } catch (err) {
        console.warn('Gemini Document Analysis failed, falling back to Sovereign Parser:', err);
      }
    }

    return this.parseSovereign(text, filename);
  }

  /**
   * Analyzes an uploaded file from disk (handles plain text, PDF, images)
   */
  static async analyzeFile(filePath: string, filename: string, mimetype?: string): Promise<{ text: string; analysis: DocumentAnalysisResult }> {
    let extractedText = '';
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    if (ext === 'pdf' || mimetype === 'application/pdf') {
      try {
        const buf = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: buf });
        const parsed = await parser.getText();
        extractedText = typeof parsed === 'string' ? parsed : parsed.text || '';
      } catch (err) {
        console.warn('PDF text extraction error, falling back to buffer scan:', err);
      }
    } else if (['txt', 'json', 'csv', 'md'].includes(ext) || mimetype?.startsWith('text/')) {
      try {
        extractedText = fs.readFileSync(filePath, 'utf8');
      } catch {}
    }

    if (!extractedText || extractedText.trim().length === 0) {
      try {
        const buf = fs.readFileSync(filePath);
        extractedText = buf.toString('latin1').replace(/[^\x20-\x7E\r\n]/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
      } catch {
        extractedText = filename;
      }
    }

    const gemini = this.getGeminiClient();
    if (gemini && fs.existsSync(filePath)) {
      try {
        const base64Data = fs.readFileSync(filePath).toString('base64');
        const mime = mimetype || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg');

        const response = await gemini.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: [
            { inlineData: { data: base64Data, mimeType: mime } },
            `You are an official government intake OCR engine for DocTrail.
Analyze this document strictly:
1. Determine if it is a legitimate statutory government application (Arms/Gun License, Passport Re-issuance, Commercial Trade License, Borewell Drilling Clearance) or supporting government proof (Aadhaar, Utility Bill).
2. If it is an unrelated, random, personal, or unsupported document (e.g. invoice, resume, receipt, personal essay, random image, test file), set "documentType": "unrecognized_document", "confidenceScore": 0.1, and clearly state in "summary" that it is not a valid government application.
Return strictly JSON matching:
{
  "documentType": string,
  "applicantName": string or null,
  "idNumber": string or null,
  "address": string or null,
  "confidenceScore": number,
  "summary": string,
  "extractedText": string
}`,
          ],
          config: { responseMimeType: 'application/json' },
        });

        const raw = typeof (response as any).text === 'function' ? (response as any).text() : (response as any).text;
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            text: parsed.extractedText || extractedText || filename,
            analysis: {
              documentType: parsed.documentType || 'unrecognized_document',
              applicantName: parsed.applicantName,
              idNumber: parsed.idNumber,
              address: parsed.address,
              confidenceScore: parsed.confidenceScore || 0.95,
              extractedFields: {
                applicantName: parsed.applicantName,
                maskedIdNumber: parsed.idNumber ? SecurityEngine.maskPii(parsed.idNumber) : undefined,
                address: parsed.address,
                documentType: parsed.documentType,
              },
              summary: parsed.summary || 'Multimodal AI document analysis completed.',
            },
          };
        }
      } catch (err) {
        console.warn('Gemini multimodal analysis failed, falling back to sovereign parser:', err);
      }
    }

    const analysis = await this.analyzeDocument(extractedText, filename);
    return { text: extractedText, analysis };
  }

  /**
   * Matches citizen intent and document metadata to the optimal public service
   */
  static async matchService(intent: string, documentType?: string): Promise<ServiceMatchResult> {
    const services = await prisma.service.findMany({
      where: { isActive: true },
      include: { stages: { where: { isActive: true }, orderBy: { orderIndex: 'asc' }, include: { department: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const q = `${intent} ${documentType ?? ''}`.toLowerCase();

    let bestScore = 0;
    let bestService: (typeof services)[0] | null = null;
    let reasoning = 'No matching statutory service recognized.';

    const rules: Array<{ terms: string[]; keys: string[] }> = [
      { terms: ['gun', 'weapon', 'firearm', 'arms', 'form a-1', 'pistol', 'revolver', 'ammunition'], keys: ['gun'] },
      { terms: ['passport', 'consular', 'tatkaal', 'reissue', 'travel document'], keys: ['passport'] },
      { terms: ['trade', 'commercial', 'cafe', 'restaurant', 'shop', 'business operation', 'gumasta'], keys: ['trade', 'food', 'hospitality'] },
      { terms: ['borewell', 'groundwater', 'ground water', 'hydro', 'water table', 'drilling'], keys: ['borewell'] },
    ];

    for (const svc of services) {
      let score = 0;
      const svcKey = svc.key.toLowerCase();
      for (const rule of rules) {
        if (rule.terms.some(t => q.includes(t)) && rule.keys.some(k => svcKey.includes(k))) score += 20;
      }
      // Prefer the canonical registered service when several share a keyword
      if (score > bestScore) {
        bestScore = score;
        bestService = svc;
        reasoning = `Matched intent keywords to ${svc.name} (${svc.stages.length} statutory workflow stages).`;
      }
    }

    const isRecognized = bestService !== null && bestScore >= 10 && documentType !== 'unrecognized_document';
    const targetService = isRecognized ? bestService! : services[0]!;
    const firstStage = targetService.stages[0];
    const stageReqs = firstStage ? ServiceConfig.requiredDocuments(targetService.configJson, firstStage.stageKey) : [];

    const alternatives = services
      .filter(s => s.id !== targetService.id)
      .slice(0, 2)
      .map(s => ({ serviceKey: s.key, serviceName: s.name, confidence: isRecognized ? 0.65 : 0.1 }));

    return {
      isRecognized,
      bestMatch: {
        serviceId: targetService.id,
        serviceKey: targetService.key,
        serviceName: targetService.name,
        category: ServiceConfig.category(targetService.configJson),
        confidence: isRecognized ? 0.95 : 0.1,
        reasoning: isRecognized ? reasoning : 'Document content did not match any recognized statutory public service application.',
        requiredDocuments: stageReqs,
        firstStage: {
          name: firstStage?.name || 'Initial Verification',
          departmentCode: firstStage?.departmentCode || 'DM_OFFICE',
          slaDays: firstStage?.slaDays || 2,
        },
      },
      alternativeMatches: alternatives,
    };
  }
}
