# Amazon Connect - Estimated Wait Time and Position in Queue

Display real-time Estimated Wait Time (EWT) and Position in Queue to customers waiting in an Amazon Connect chat queue.

## Overview

This solution uses an AWS Lambda function invoked from an Amazon Connect Customer Queue Flow to retrieve and announce real-time queue metrics to customers while they wait. It leverages two Amazon Connect APIs:

- **GetContactMetrics**: Returns the specific contact's position in queue and personalized EWT
- **GetCurrentMetricData**: Returns queue-level metrics including EWT, contacts in queue, and agent availability

The solution is deployed with the AWS Cloud Development Kit (AWS CDK).

Beyond standard Amazon Connect chat usage, this solution incurs charges only for AWS Lambda requests and Amazon CloudWatch Logs. There is no additional charge for the GetContactMetrics and GetCurrentMetricData API requests.

### The metrics behind the experience

Two metrics drive this solution:

- **Estimated Wait Time (EWT)** estimates, in seconds, how long a contact will wait before connecting to an agent. It is calculated from the contact's position in queue, the rate at which contacts connect and disconnect, and a correction factor that improves accuracy over time. EWT is available at three levels: the **queue level** (wait time for a new contact entering a queue, from `GetCurrentMetricData`), the **routing-step level** (available when proficiency-based routing is configured, from `GetCurrentMetricData` grouped on `ROUTING_STEP_EXPRESSION`), and the **contact level** (remaining wait time for a specific contact already in queue, from `GetContactMetrics`).
- **Position in Queue (PIQ)** returns a contact's current position within a queue, so you can tell customers how many contacts are ahead of them. It is available only after the contact has entered a queue. For contacts that use routing criteria, it reflects the position within the active routing step.

EWT requires **Next Generation Amazon Connect** and is returned only when the system can produce a prediction with sufficient confidence from current queue conditions and historical data. When confidence is low, the EWT value is not returned and the API response may be empty. This solution handles that case by falling back to a less specific source (see [Priority logic](#priority-logic)).

## Architecture

```
Customer Chat -> Main Flow -> Set Queue -> Set Customer Queue Flow -> Transfer to Queue
                                                |
                                                v
                                    Customer Queue Flow (loops every 30s)
                                                |
                                                v
                                        Lambda Function
                                        - GetContactMetrics API (position, contact EWT)
                                        - GetCurrentMetricData API (queue metrics, queue EWT)
                                                |
                                                v
                                    Announce to Customer:
                                    "You are #2 in queue. EWT: 45 seconds."
```

## Prerequisites

- An AWS account
- An Amazon Connect instance with **Next Generation Amazon Connect** enabled (you will need the ARN of your instance)
- A queue configured with at least one routing profile that supports chat
- Node.js (Long Term Support version v18 or higher)
- Git installed
- Basic knowledge of Amazon Connect and the AWS Cloud Development Kit v2 (AWS CDK)
- The AWS CDK Toolkit (CLI). This project pins a compatible CLI in its dev dependencies, so the simplest option is to run the CDK commands below with `npx cdk ...` (used throughout this README) after `npm ci`, which uses the pinned version automatically — no global install required.

  If you prefer a global install, make sure it is recent enough for the `aws-cdk-lib` version this project uses (**CDK CLI v2.1144.0 or later**). An older global CLI fails with a "Cloud assembly schema version mismatch" error. Install or upgrade with:

  ```bash
  npm install -g aws-cdk@latest
  ```

## Deployment

Run the following steps in the same Region where your Amazon Connect instance is deployed.

1. Clone the repository and move into the project directory:

   ```bash
   git clone https://github.com/aws-samples/sample-amazon-connect-wait-time-queue-position.git
   cd sample-amazon-connect-wait-time-queue-position
   ```

2. Get the ARN of the Amazon Connect instance that will host the Customer Queue Flow. You can find it in the Amazon Connect console on your instance's detail page, or retrieve it with the AWS CLI:

   ```bash
   aws connect list-instances --query "InstanceSummaryList[].{Alias:InstanceAlias,Arn:Arn}" --output table
   ```

   This command requires the `connect:ListInstances` permission and returns every Amazon Connect instance in the account and Region. If you already know your instance, copy the ARN from the console instead.

3. Set the environment variables for your AWS credentials.

4. Install the dependencies and bootstrap the CDK environment:

   ```bash
   npm ci
   npx cdk bootstrap
   ```

5. Deploy the solution. Replace `<YOUR-CONNECT-INSTANCE-ARN>` with the ARN from step 2. You are prompted with a summary of the IAM changes, enter `y` to proceed:

   ```bash
   npx cdk deploy ConnectEWTStack --parameters instanceArn=<YOUR-CONNECT-INSTANCE-ARN>
   ```

On completion, the stack creates the Lambda function, its IAM role and policy, an SQS dead-letter queue, the Lambda invoke permission, the integration association, and the `CustomerQueueFlow-EWT` Customer Queue Flow. The Lambda ARN is already wired into the flow's Invoke AWS Lambda function block, so there is no need to select it by hand.

One console step remains to connect the flow to your contact center. In your main inbound contact flow, add a **Set customer queue flow** block pointing to `CustomerQueueFlow-EWT`. Place it after the "Set working queue" block and before the "Transfer to queue" block:

```
... -> Set working queue -> Set customer queue flow (CustomerQueueFlow-EWT) -> Transfer to queue
```

Order matters: "Set working queue" must run first so the flow knows which queue's metrics to read, and "Set customer queue flow" must run before "Transfer to queue" so the announcement loop is registered before the contact is enqueued.

## Test the solution

Use the test chat within the Amazon Connect console:

1. Open the CCP (Contact Control Panel) and set your agent status to a non-routable status (for example, Offline), so test contacts stay in queue rather than routing immediately.
2. Log in to your Amazon Connect instance and from the home screen choose **Test Chat**.
3. Choose **Test Settings**, select your main contact flow, and choose **Apply**.
4. Start a chat and send a message.

While the chat waits in the queue, the customer sees messages such as:

- First message: *"Thank you for waiting. We are checking your position. Your estimated wait time is approximately X seconds."*
- Subsequent messages (every 30 seconds): *"Thank you for waiting. You are number X in the queue. Your estimated wait time is approximately X."*

To confirm the Lambda function is being invoked and returning metrics, view its logs in Amazon CloudWatch:

```bash
aws logs tail /aws/lambda/getEstimatedWaitTime-ConnectEWTStack --since 10m --format short
```

## How it works

The Lambda function reads queue information from both Connect metric APIs and selects the best available values to return to the Customer Queue Flow.

- **GetContactMetrics (contact level)** returns the specific contact's position in queue and a personalized EWT prediction. These values may be absent in the first moments after a contact enters the queue, so the function prefers them when present and falls back when they are not.
- **GetCurrentMetricData (queue level)** returns real-time metrics for the whole queue, including contacts in queue, oldest contact age, and queue-level EWT. These are available whenever there is queue activity. To return `ESTIMATED_WAIT_TIME`, the request groups results by `QUEUE` and `CHANNEL` and filters on the chat channel.

### Priority logic

The function resolves position in queue and estimated wait time from the most specific source available:

| Metric | Priority 1 | Priority 2 | Priority 3 |
|--------|-----------|-----------|-----------|
| Position | GetContactMetrics | `"unknown"` (handled in flow) | Not applicable |
| Estimated wait time | Contact-level EWT | Queue-level EWT | Oldest contact age |

### Lambda response attributes

The function returns the following attributes, accessible in the Customer Queue Flow through `$.External.*`:

| Attribute | Description | Example |
|-----------|-------------|---------|
| `PositionInQueue` | Contact's position in queue | `"2"` |
| `EstimatedWaitTimeSeconds` | Estimated wait time in seconds | `"45"` |
| `EstimatedWaitTimeMinutes` | Estimated wait time in minutes | `"less than 1"` |
| `EstimatedWaitTimeDisplay` | Human-readable estimated wait time | `"45 seconds"` |
| `EWTSource` | Which API provided the estimated wait time | `"CONTACT_API"` |
| `ContactsInQueue` | Total contacts waiting | `"3"` |
| `AgentsOnline` | Agents logged in | `"5"` |
| `AgentsAvailable` | Agents ready for contacts | `"2"` |

### Adapting to other channels

This implementation filters on the chat channel. To support voice or task contacts, update the Lambda function to detect the channel from the event:

```python
channel = event["Details"]["ContactData"]["Channel"]  # "CHAT", "VOICE", or "TASK"
```

Then use the detected channel in the `GetCurrentMetricData` filters:

```python
"Channels": [channel]
```

## Clean up

To remove all resources created by the stack, run the following from the project directory, then enter `y` to confirm:

```bash
npx cdk destroy ConnectEWTStack
```

Then, in the Amazon Connect console, remove the **Set customer queue flow** block from your main contact flow, or point it to a different flow.

## Repository Structure

```
sample-amazon-connect-wait-time-queue-position/   # Repo root, run CDK commands from here
├── bin/
│   └── app.ts                            # CDK app entry point
├── lib/
│   └── connect-ewt-stack.ts              # CDK stack: Lambda, IAM, flow, and association
├── lambda/
│   └── index.py                          # Lambda function source code
├── package.json
├── tsconfig.json
├── cdk.json
└── README.md                             # This file
```

## What the CDK Stack Deploys

| Resource | Type | Description |
|----------|------|-------------|
| Lambda Function | `AWS::Lambda::Function` | Retrieves EWT and position via Connect APIs |
| IAM Role and Managed Policy | `AWS::IAM::Role`, `AWS::IAM::ManagedPolicy` | Execution role scoped to the two Connect metric actions |
| Dead-Letter Queue | `AWS::SQS::Queue` | Captures failed asynchronous invocations |
| Lambda Permission | `AWS::Lambda::Permission` | Allows Connect to invoke the Lambda |
| Integration Association | `AWS::Connect::IntegrationAssociation` | Associates the Lambda with your Connect instance |
| Customer Queue Flow | `AWS::Connect::ContactFlow` | Flow that loops and announces wait time |

## Key Features

- **Accurate position tracking**: Uses GetContactMetrics for per-contact position
- **Smart EWT fallback**: Contact-level EWT, then queue-level EWT, then oldest contact age
- **Graceful first-message handling**: Shows a simplified message when position is not available yet
- **One-command deployment**: CDK provisions the Lambda, IAM, Connect association, and flow
- **Multi-channel ready**: Easily adaptable for voice and task channels
- **Loop updates**: Refreshes metrics every 30 seconds

## Security

- Lambda uses least-privilege IAM with only `connect:GetCurrentMetricData` and `connect:GetContactMetrics`
- Resource-scoped to your specific Connect instance
- SigV4-signed API requests

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
