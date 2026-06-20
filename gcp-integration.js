/**
 * AlphaMan GCP Integration Layer
 * Connect frontend to Google Cloud Storage, Vertex AI, BigQuery, Identity Platform
 * 
 * Required env vars (set in window.ALPHAMAN_CONFIG):
 *   GCP_PROJECT_ID, GCS_BUCKET, BIGQUERY_DATASET, VERTEX_ENDPOINT, IDENTITY_CLIENT_ID
 */

const AlphaManGCP = (function() {
  'use strict';

  const PROJECT = window.ALPHAMAN_CONFIG?.GCP_PROJECT_ID || '1072744478986';
  const BUCKET  = window.ALPHAMAN_CONFIG?.GCS_BUCKET     || 'alphaman-cv-intake';
  const DATASET = window.ALPHAMAN_CONFIG?.BIGQUERY_DATASET || 'alphaman_production';

  // ── 1. CLOUD STORAGE — File Upload ──────────────────────────

  async function uploadCV(file, candidateId) {
    const token = await getAuthToken();
    const ext = file.name.split('.').pop();
    const objectName = `cvs/${candidateId}_${Date.now()}.${ext}`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': file.type || 'application/octet-stream'
      },
      body: file
    });

    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const result = await response.json();
    
    // Trigger Vertex AI parsing
    triggerParsing(result.name, candidateId);
    
    return { objectName: result.name, url: `gs://${BUCKET}/${objectName}` };
  }

  // ── 2. VERTEX AI — CV Parsing ───────────────────────────────

  async function triggerParsing(objectName, candidateId) {
    const token = await getAuthToken();
    const endpoint = window.ALPHAMAN_CONFIG?.VERTEX_ENDPOINT ||
      `https://asia-southeast1-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/asia-southeast1/endpoints/alphaman-cv-parser:predict`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instances: [{
            gcs_uri: `gs://${BUCKET}/${objectName}`,
            candidate_id: candidateId
          }]
        })
      });
      
      const result = await response.json();
      const parsed = result.predictions?.[0] || {};
      
      // Log structured data to BigQuery
      await logToBigQuery('candidate_profiles', {
        candidate_id: candidateId,
        skills: parsed.skills || [],
        years_experience: parsed.years_experience || null,
        industry: parsed.industry || null,
        education: parsed.education || [],
        parsed_at: new Date().toISOString()
      });

      // Trigger match engine
      await triggerMatchEngine(candidateId, null);
      
      return parsed;
    } catch (e) {
      console.error('Vertex AI parse failed:', e);
      return null;
    }
  }

  // ── 3. BIGQUERY — Structured Data Pipeline ──────────────────

  async function logToBigQuery(table, data) {
    const token = await getAuthToken();
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${DATASET}/tables/${table}/insertAll`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          rows: [{ json: data }]
        })
      });
      console.log(`[BigQuery] Row inserted → ${DATASET}.${table}`);
    } catch (e) {
      console.error(`[BigQuery] Insert failed:`, e);
    }
  }

  function logJobPosting(job) {
    return logToBigQuery('job_postings', {
      job_id: job.job_id || `JOB-${Date.now()}`,
      title: job.title,
      company: job.company,
      industry: job.industry,
      location: job.location,
      salary_range: job.salary,
      closes_at: job.closeDate,
      posted_at: new Date().toISOString(),
      status: 'active'
    });
  }

  // ── 4. VERTEX AI — Two-Way Match Engine ─────────────────────

  async function triggerMatchEngine(candidateId, jobId) {
    const token = await getAuthToken();
    const url = `https://asia-southeast1-${PROJECT}.cloudfunctions.net/alphaman-match-engine`;

    try {
      const payload = candidateId
        ? { trigger: 'cv_deposit', candidate_id: candidateId }
        : { trigger: 'job_posting', job_id: jobId };
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      console.log(`[Match Engine] ${result.matches} matches found`);
      return result;
    } catch (e) {
      console.error('[Match Engine] Failed:', e);
      return null;
    }
  }

  // ── 5. IDENTITY PLATFORM — Google Sign-In ──────────────────

  function initGoogleIdentity(containerId, onLogin) {
    const clientId = window.ALPHAMAN_CONFIG?.IDENTITY_CLIENT_ID;
    if (!clientId || !window.google?.accounts?.id) {
      console.warn('[Identity] Google Identity Services not loaded');
      return;
    }

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        // Decode JWT credential
        const payload = JSON.parse(atob(response.credential.split('.')[1]));
        onLogin({
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
          id_token: response.credential
        });
      },
      auto_select: false,
      cancel_on_tap_outside: true
    });

    window.google.accounts.id.renderButton(
      document.getElementById(containerId),
      { theme: 'outline', size: 'large', width: '100%' }
    );
  }

  // ── Helpers ─────────────────────────────────────────────────

  async function getAuthToken() {
    // Priority: Google Identity token → OAuth token → API key
    const idToken = sessionStorage.getItem('alphaman_id_token');
    if (idToken) return idToken;
    
    // Fallback: use API key for unauthenticated GCS uploads
    const apiKey = window.ALPHAMAN_CONFIG?.GCP_API_KEY || 'AIzaSyBiPKBp0biybHKa7Wc5Q0HjFj88ACcSVkU';
    if (apiKey) return apiKey;
    
    throw new Error('No auth token available');
  }

  // ── Init ────────────────────────────────────────────────────

  function init(config) {
    window.ALPHAMAN_CONFIG = { ...window.ALPHAMAN_CONFIG, ...config };
    
    // Load Google Identity Services
    if (config.IDENTITY_CLIENT_ID && !document.getElementById('gis-script')) {
      const script = document.createElement('script');
      script.id = 'gis-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      document.head.appendChild(script);
    }
    
    console.log(`[AlphaMan GCP] Initialized — Project: ${PROJECT}, Bucket: ${BUCKET}, Dataset: ${DATASET}`);
    return { PROJECT, BUCKET, DATASET };
  }

  return {
    init,
    uploadCV,
    triggerParsing,
    logToBigQuery,
    logJobPosting,
    triggerMatchEngine,
    initGoogleIdentity,
    getAuthToken
  };
})();

// Auto-init with null config — set window.ALPHAMAN_CONFIG before DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  if (window.ALPHAMAN_CONFIG?.GCP_PROJECT_ID) {
    AlphaManGCP.init(window.ALPHAMAN_CONFIG);
  }
});
