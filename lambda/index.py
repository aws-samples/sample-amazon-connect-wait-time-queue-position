# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Amazon Connect - Estimated Wait Time and Position in Queue Lambda Function

This Lambda function is invoked from an Amazon Connect Customer Queue Flow to retrieve
real-time queue metrics and contact-level position information. It calls two APIs:

1. GetContactMetrics - Returns the specific contact's position in queue and EWT
2. GetCurrentMetricData - Returns queue-level metrics (contacts in queue, agents online, EWT)

The function returns a flat string map that can be referenced in the contact flow
using $.External.* attributes.

Requirements:
- Next Generation Amazon Connect must be enabled for ESTIMATED_WAIT_TIME
- Lambda execution role needs connect:GetCurrentMetricData and connect:GetContactMetrics
- Lambda must be associated with the Connect instance (Contact flows > AWS Lambda)
"""

import boto3
import json
import logging
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import urllib.request
import urllib.error

logger = logging.getLogger()
logger.setLevel(logging.INFO)

session = boto3.Session()
credentials = session.get_credentials().get_frozen_credentials()
region = session.region_name or "us-east-1"


def lambda_handler(event, context):
    """
    Main handler invoked by Amazon Connect.

    Connect automatically passes contact data including ContactId, InstanceARN,
    and Queue information in the event payload.
    """
    logger.info("Received event: %s", event)

    contact_id = event["Details"]["ContactData"]["ContactId"]
    instance_arn = event["Details"]["ContactData"]["InstanceARN"]
    instance_id = instance_arn.split("/")[-1]
    queue_arn = event["Details"]["ContactData"].get("Queue", {}).get("ARN", "")

    logger.info("ContactId: %s", contact_id)
    logger.info("InstanceId: %s", instance_id)
    logger.info("QueueARN: %s", queue_arn)

    if not queue_arn:
        logger.error("No queue ARN found in event")
        return _unknown_result()

    # Call both APIs for comprehensive metrics
    contact_metrics = _get_contact_metrics(instance_id, contact_id)
    queue_metrics = _get_queue_metrics(instance_id, queue_arn)

    # Position: Only use contact-level position (accurate per-contact)
    # Queue size is not the same as position and would be misleading
    position_in_queue = contact_metrics.get("position", "")
    if not position_in_queue:
        position_in_queue = "unknown"

    # EWT priority: contact-level > queue-level > oldest contact age (fallback)
    ewt_seconds = (
        contact_metrics.get("ewt")
        or queue_metrics.get("ewt")
        or queue_metrics.get("oldest_contact_age", "0")
    )
    ewt_source = (
        "CONTACT_API" if contact_metrics.get("ewt")
        else "QUEUE_API" if queue_metrics.get("ewt")
        else "OLDEST_AGE_FALLBACK"
    )

    # Format wait time for display
    secs = int(ewt_seconds) if ewt_seconds and ewt_seconds != "unknown" else 0
    if secs < 60:
        wait_minutes = "less than 1"
        wait_display = f"{secs} seconds"
    else:
        minutes = secs // 60
        wait_minutes = str(minutes)
        wait_display = f"{wait_minutes} minutes"

    result = {
        "PositionInQueue": str(position_in_queue),
        "EstimatedWaitTimeSeconds": str(ewt_seconds),
        "EstimatedWaitTimeMinutes": wait_minutes,
        "EstimatedWaitTimeDisplay": wait_display,
        "EWTSource": ewt_source,
        "ContactsInQueue": queue_metrics.get("contacts_in_queue", "unknown"),
        "AgentsOnline": queue_metrics.get("agents_online", "unknown"),
        "AgentsAvailable": queue_metrics.get("agents_available", "unknown"),
    }

    logger.info("Returning result: %s", result)
    return result


def _get_contact_metrics(instance_id, contact_id):
    """
    Call GetContactMetrics API for contact-level position and EWT.

    This API returns metrics specific to an individual contact:
    - POSITION_IN_QUEUE: The contact's actual position in the queue
    - ESTIMATED_WAIT_TIME: Predicted wait time for this specific contact

    Note: Metrics are only available after the contact is actively in queue.
    On the first invocation, this may return empty results.
    """
    try:
        url = f"https://connect.{region}.amazonaws.com/metrics/contact"
        payload = json.dumps({
            "InstanceId": instance_id,
            "ContactId": contact_id,
            "Metrics": [
                {"Name": "ESTIMATED_WAIT_TIME"},
                {"Name": "POSITION_IN_QUEUE"},
            ],
        })

        response_body = _make_signed_request(url, payload)
        logger.info("GetContactMetrics response: %s", response_body)

        result = {}
        metric_results = response_body.get("MetricResults") or []
        for metric in metric_results:
            name = metric.get("Name")
            value = metric.get("Value", {}).get("Number")
            if name == "POSITION_IN_QUEUE" and value is not None:
                result["position"] = str(int(value))
            elif name == "ESTIMATED_WAIT_TIME" and value is not None:
                result["ewt"] = str(int(value))

        return result

    except Exception as e:
        logger.warning("GetContactMetrics failed: %s - %s", type(e).__name__, str(e))
        return {}


def _get_queue_metrics(instance_id, queue_arn):
    """
    Call GetCurrentMetricData API for queue-level metrics.

    This API returns real-time metrics for the entire queue:
    - CONTACTS_IN_QUEUE: Total contacts waiting
    - OLDEST_CONTACT_AGE: How long the oldest contact has been waiting
    - AGENTS_ONLINE: Agents logged in for this queue/channel
    - AGENTS_AVAILABLE: Agents ready to take contacts
    - ESTIMATED_WAIT_TIME: Queue-level EWT prediction

    Requires Groupings: ["QUEUE", "CHANNEL"] for ESTIMATED_WAIT_TIME.
    """
    try:
        url = f"https://connect.{region}.amazonaws.com/metrics/current/{instance_id}"
        payload = json.dumps({
            "Filters": {
                "Queues": [queue_arn],
                "Channels": ["CHAT"]
            },
            "Groupings": ["QUEUE", "CHANNEL"],
            "CurrentMetrics": [
                {"Name": "CONTACTS_IN_QUEUE", "Unit": "COUNT"},
                {"Name": "OLDEST_CONTACT_AGE", "Unit": "SECONDS"},
                {"Name": "AGENTS_ONLINE", "Unit": "COUNT"},
                {"Name": "AGENTS_AVAILABLE", "Unit": "COUNT"},
                {"Name": "ESTIMATED_WAIT_TIME", "Unit": "SECONDS"},
            ]
        })

        response_body = _make_signed_request(url, payload)
        logger.info("GetCurrentMetricData response: %s", response_body)

        result = {}
        metric_results = response_body.get("MetricResults") or []
        for item in metric_results:
            collections = item.get("Collections") or []
            for collection in collections:
                metric_name = collection.get("Metric", {}).get("Name", "")
                value = collection.get("Value")
                if value is None:
                    continue
                if metric_name == "CONTACTS_IN_QUEUE":
                    result["contacts_in_queue"] = str(int(value))
                elif metric_name == "OLDEST_CONTACT_AGE":
                    result["oldest_contact_age"] = str(int(value))
                elif metric_name == "AGENTS_ONLINE":
                    result["agents_online"] = str(int(value))
                elif metric_name == "AGENTS_AVAILABLE":
                    result["agents_available"] = str(int(value))
                elif metric_name == "ESTIMATED_WAIT_TIME":
                    result["ewt"] = str(int(value))

        return result

    except Exception as e:
        logger.warning("GetCurrentMetricData failed: %s - %s", type(e).__name__, str(e))
        return {}


def _make_signed_request(url, payload):
    """
    Make a SigV4-signed POST request to AWS Connect API.

    We call the REST APIs directly instead of using boto3's connect client
    because the GetContactMetrics method may not be available in the
    Lambda runtime's bundled boto3 version.
    """
    headers = {"Content-Type": "application/json"}
    aws_request = AWSRequest(method="POST", url=url, data=payload, headers=headers)
    SigV4Auth(credentials, "connect", region).add_auth(aws_request)

    # Validate URL scheme to ensure only HTTPS is used (addresses B310 audit)
    if not url.startswith("https://"):
        raise ValueError(f"Only HTTPS URLs are permitted, got: {url}")

    req = urllib.request.Request(
        url=url,
        data=payload.encode("utf-8"),
        headers=dict(aws_request.headers),
        method="POST",
    )

    with urllib.request.urlopen(req) as response:  # nosec B310
        raw_body = response.read().decode("utf-8")

    return json.loads(raw_body)


def _unknown_result():
    """Return default unknown values when metrics cannot be retrieved."""
    return {
        "PositionInQueue": "unknown",
        "EstimatedWaitTimeSeconds": "unknown",
        "EstimatedWaitTimeMinutes": "unknown",
        "EstimatedWaitTimeDisplay": "unknown",
        "EWTSource": "unknown",
        "ContactsInQueue": "unknown",
        "AgentsOnline": "unknown",
        "AgentsAvailable": "unknown",
    }
