<?php

header("Content-Type: application/json");

/* ========================
   LOAD ENV
======================== */
include("../../config/env.php");
loadEnv("../../config/.env");

/* ========================
   DB CONNECTION
======================== */
include("../../config/db.php");

/* ========================
   GET API KEY FROM ENV
======================== */
$VALID_KEY = getenv('NBFC_API_KEY');

/*
   Accept the env key PLUS both common spellings of the shared key.
   The stored value is misspelled "ACESS"; integrators (e.g. Salesforce)
   often type the natural "ACCESS". Both are treated as valid.
*/
$ACCEPTED_KEYS = array_values(array_unique(array_filter([
    $VALID_KEY,
    'NBFC_ACESS_KEY_1234',
    'NBFC_ACCESS_KEY_1234',
    'NBFC_SECRET_KEY_123',
], 'strlen')));

/* ========================
   DIAGNOSTIC REQUEST LOGGING (TEMPORARY — REMOVE AFTER DEBUGGING)
   Captures every incoming request so we can see exactly what an
   integrator (e.g. Bajaj) sends: raw body, headers, query, and the
   response we returned. One JSON object per line.
   Log file lives NEXT TO this script; view it via File Manager at:
     public_html/api/external/validate_battery_requests.log
   NOTE: it contains the access key — delete the file when done and
   do not share its URL publicly.
======================== */
$LOG_FILE    = __DIR__ . '/validate_battery_requests.log';
$RAW_BODY    = file_get_contents("php://input");
$REQ_HEADERS = [];
if (function_exists('getallheaders')) {
    foreach (getallheaders() as $hk => $hv) {
        $REQ_HEADERS[$hk] = $hv;
    }
}

function logRequest($code, $msg)
{
    global $LOG_FILE, $RAW_BODY, $REQ_HEADERS;
    $entry = [
        "time"         => date("Y-m-d H:i:s"),
        "ip"           => $_SERVER['REMOTE_ADDR']    ?? '',
        "method"       => $_SERVER['REQUEST_METHOD'] ?? '',
        "content_type" => $_SERVER['CONTENT_TYPE']   ?? '',
        "headers"      => $REQ_HEADERS,
        "raw_body"     => $RAW_BODY,
        "query"        => $_GET,
        "post"         => $_POST,
        "response"     => ["responseStatus" => $code, "responseMessage" => $msg],
    ];
    @file_put_contents(
        $LOG_FILE,
        json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
        FILE_APPEND | LOCK_EX
    );
}

function respond($code, $msg)
{
    logRequest($code, $msg);
    echo json_encode([
        "responseStatus" => $code,
        "responseMessage" => $msg
    ]);
    exit;
}

/* ========================
   READ ACCESS KEY FROM ANY COMMON LOCATION
   (JSON body, form/query params, or HTTP header)
======================== */
function extractAccessKey($data)
{
    // 1) JSON body / form-encoded body / query string
    foreach ([$data, $_POST, $_GET] as $src) {
        if (isset($src['accessKey']) && trim($src['accessKey']) !== '') {
            return trim($src['accessKey']);
        }
    }

    // 2) HTTP headers (accessKey / X-Access-Key / Authorization: Bearer <key>)
    $headers = [];
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            $headers[strtolower($k)] = $v;
        }
    }
    // $_SERVER fallback (used when getallheaders() is unavailable)
    if (!empty($_SERVER['HTTP_ACCESSKEY']))     $headers['accesskey']     = $_SERVER['HTTP_ACCESSKEY'];
    if (!empty($_SERVER['HTTP_X_ACCESS_KEY']))  $headers['x-access-key']  = $_SERVER['HTTP_X_ACCESS_KEY'];
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) $headers['authorization'] = $_SERVER['HTTP_AUTHORIZATION'];

    if (!empty($headers['accesskey']))    return trim($headers['accesskey']);
    if (!empty($headers['x-access-key'])) return trim($headers['x-access-key']);
    if (!empty($headers['authorization'])) {
        return trim(preg_replace('/^Bearer\s+/i', '', $headers['authorization']));
    }

    return '';
}

/* ========================
   PICK A FIELD FROM JSON BODY, THEN FORM/QUERY PARAMS
======================== */
function pickField($data, $keys)
{
    foreach ((array) $keys as $k) {
        foreach ([$data, $_POST, $_GET] as $src) {
            if (isset($src[$k]) && trim($src[$k]) !== '') {
                return trim($src[$k]);
            }
        }
    }
    return '';
}

/* ========================
   METHOD CHECK
======================== */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(-98, "Invalid request method");
}

/* ========================
   INPUT
   Reuse the raw body captured above (php://input can only be
   read reliably once), then fall back to $_POST / $_GET params.
======================== */
$data = json_decode($RAW_BODY, true);
if (!is_array($data)) {
    $data = [];
}

$battery_id    = pickField($data, 'battery_id');
$dealer_id     = pickField($data, 'dealer_id');
$material_code = pickField($data, ['materialCode', 'material_code']);
$accessKey     = extractAccessKey($data);

/* ========================
   AUTH CHECK
======================== */
if (!in_array($accessKey, $ACCEPTED_KEYS, true)) {
    respond(-99, "Unauthorized access");
}

/* ========================
   REQUIRED FIELDS
======================== */
if ($battery_id === '' || $dealer_id === '' || $material_code === '') {
    respond(-97, "Missing required fields");
}

/* ========================
   FETCH BATTERY
======================== */
$stmt = $conn->prepare("
    SELECT dealer_id, material_code, model_number
    FROM itarang_inventory
    WHERE battery_id = ?
    LIMIT 1
");

if (!$stmt) {
    respond(-96, "Database prepare failed");
}

$stmt->bind_param("s", $battery_id);
$stmt->execute();
$result = $stmt->get_result();

if (!$result || $result->num_rows === 0) {
    respond(-1, "Invalid Serial Number");
}

$row = $result->fetch_assoc();

/* ========================
   DEALER CHECK
======================== */
if (trim($row['dealer_id']) !== $dealer_id) {
    respond(-5, "Serial Number not billed to this dealer");
}

/* ========================
   MATERIAL CHECK
   IMPORTANT:
   Compare incoming materialCode only with
   the DB column material_code
======================== */
$expectedMaterialCode = trim($row['material_code']);

if ($expectedMaterialCode !== $material_code) {
    respond(-4, "Invalid Material code");
}

/* ========================
   ALREADY VALIDATED CHECK
======================== */
$checkValidated = $conn->prepare("
    SELECT id
    FROM battery_validation_log
    WHERE battery_id = ? AND dealer_id = ? AND material_code = ?
    LIMIT 1
");

if (!$checkValidated) {
    respond(-96, "Database prepare failed");
}

$checkValidated->bind_param("sss", $battery_id, $dealer_id, $material_code);
$checkValidated->execute();
$validatedResult = $checkValidated->get_result();

if ($validatedResult && $validatedResult->num_rows > 0) {
    respond(99, "99# Serial No Already validated ($battery_id)");
}

/* ========================
   INSERT VALIDATION LOG
======================== */
$insertValidated = $conn->prepare("
    INSERT INTO battery_validation_log (
        battery_id,
        dealer_id,
        material_code,
        validated_at,
        created_at,
        updated_at
    ) VALUES (?, ?, ?, NOW(), NOW(), NOW())
");

if (!$insertValidated) {
    respond(-96, "Database prepare failed");
}

$insertValidated->bind_param("sss", $battery_id, $dealer_id, $material_code);

if (!$insertValidated->execute()) {
    respond(-96, "Failed to store validation status");
}

/* ========================
   SUCCESS
======================== */
respond(0, "Valid Serial Number");
