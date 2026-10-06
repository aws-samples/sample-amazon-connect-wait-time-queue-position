// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as path from 'path';

/**
 * Deploys the Amazon Connect Estimated Wait Time and Position in Queue solution:
 *   - A Lambda function that retrieves queue metrics
 *   - A least-privilege IAM role and managed policy for the two Connect metric APIs
 *   - An SQS dead-letter queue
 *   - A permission allowing Amazon Connect to invoke the Lambda
 *   - An integration association that attaches the Lambda to the Connect instance
 *   - A Customer Queue Flow that announces EWT and position in queue
 *
 * The Amazon Connect instance ARN is supplied at deploy time:
 *   cdk deploy ConnectEWTStack --parameters instanceArn=<YOUR-INSTANCE-ARN>
 */
export class ConnectEwtStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Amazon Connect instance ARN, provided at deploy time.
    const instanceArn = new cdk.CfnParameter(this, 'instanceArn', {
      type: 'String',
      description:
        'The ARN of your Amazon Connect instance ' +
        '(e.g., arn:aws:connect:us-east-1:123456789012:instance/0d9270ec-db1f-4b7d-927f-4d30a1dfe4ee)',
      allowedPattern: '^arn:aws:connect:[a-z0-9-]+:[0-9]+:instance/[a-f0-9-]+$',
    });

    const connectInstanceArn = instanceArn.valueAsString;

    // SQS dead-letter queue for failed asynchronous Lambda invocations.
    const deadLetterQueue = new sqs.Queue(this, 'EWTLambdaDeadLetterQueue', {
      queueName: `getEstimatedWaitTime-dlq-${this.stackName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Least-privilege managed policy: only the two Connect metric read actions,
    // scoped to the specific instance, plus permission to write to the DLQ.
    const metricsPolicy = new iam.ManagedPolicy(this, 'ConnectMetricsAccessPolicy', {
      managedPolicyName: `ConnectMetricsAccess-${this.stackName}`,
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['connect:GetCurrentMetricData', 'connect:GetContactMetrics'],
          resources: [`${connectInstanceArn}/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sqs:SendMessage'],
          resources: [deadLetterQueue.queueArn],
        }),
      ],
    });

    // Lambda execution role.
    const executionRole = new iam.Role(this, 'EWTLambdaExecutionRole', {
      roleName: `ConnectEWTLambdaRole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        metricsPolicy,
      ],
    });

    // The Lambda function. CDK bundles the code from the lambda/ directory,
    // so there is no manual zip or S3 upload step.
    const ewtFunction = new lambda.Function(this, 'GetEstimatedWaitTimeFunction', {
      functionName: `getEstimatedWaitTime-${this.stackName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      reservedConcurrentExecutions: 10,
      deadLetterQueue: deadLetterQueue,
      role: executionRole,
    });

    // Allow Amazon Connect to invoke the function, scoped to this instance.
    ewtFunction.addPermission('ConnectLambdaInvokePermission', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: connectInstanceArn,
    });

    // Associate the Lambda with the Connect instance (replaces the manual
    // "add Lambda in the Connect console" step).
    const integrationAssociation = new connect.CfnIntegrationAssociation(
      this,
      'LambdaIntegrationAssociation',
      {
        instanceId: connectInstanceArn,
        integrationType: 'LAMBDA_FUNCTION',
        integrationArn: ewtFunction.functionArn,
      },
    );

    // Customer Queue Flow content. The Lambda ARN is injected into the flow's
    // Invoke Lambda block.
    const flowContent = this.buildCustomerQueueFlowContent(ewtFunction.functionArn);

    const customerQueueFlow = new connect.CfnContactFlow(this, 'CustomerQueueFlowEWT', {
      instanceArn: connectInstanceArn,
      name: 'CustomerQueueFlow-EWT',
      type: 'CUSTOMER_QUEUE',
      description:
        'Customer queue flow that periodically announces estimated wait time and position in ' +
        'queue using Lambda with GetCurrentMetricData and GetContactMetrics APIs.',
      content: flowContent,
    });

    // The flow references the function, so the association must exist first.
    customerQueueFlow.addResourceDependency(integrationAssociation);

    // Outputs.
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      description: 'ARN of the deployed Lambda function',
      value: ewtFunction.functionArn,
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      description: 'Name of the deployed Lambda function',
      value: ewtFunction.functionName,
    });

    new cdk.CfnOutput(this, 'CustomerQueueFlowArn', {
      description:
        'ARN of the Customer Queue Flow. Use this in your main contact flow\'s ' +
        '"Set customer queue flow" block before "Transfer to queue".',
      value: customerQueueFlow.attrContactFlowArn,
    });

    new cdk.CfnOutput(this, 'NextStep', {
      description:
        'After deployment, add a "Set customer queue flow" block in your main contact flow ' +
        'pointing to CustomerQueueFlow-EWT, placed before "Transfer to queue".',
      value: "Add 'Set customer queue flow' block in your main flow pointing to CustomerQueueFlow-EWT",
    });
  }

  /**
   * Builds the Customer Queue Flow JSON, injecting the Lambda ARN into the
   * Invoke Lambda block. This is the same flow definition used by the original
   * CloudFormation template.
   */
  private buildCustomerQueueFlowContent(lambdaArn: string): string {
    const flow = {
      Version: '2019-10-30',
      StartAction: 'enable-logging',
      Metadata: {
        entryPointPosition: { x: 20, y: 20 },
        ActionMetadata: {
          'enable-logging': { position: { x: 60, y: 60 } },
          'initial-wait': { position: { x: 180, y: 60 } },
          'start-loop': { position: { x: 300, y: 60 } },
          'invoke-lambda-ewt': { position: { x: 540, y: 60 } },
          'check-position': { position: { x: 780, y: 60 } },
          'announce-with-position': { position: { x: 1040, y: 20 } },
          'announce-without-position': { position: { x: 1040, y: 200 } },
          'announce-fallback': { position: { x: 780, y: 300 } },
          'wait-interval': { position: { x: 1300, y: 100 } },
        },
        Annotations: [],
        name: 'CustomerQueueFlow-EWT',
        description: 'Announces EWT and position in queue periodically.',
        type: 'customerQueue',
        status: 'PUBLISHED',
        hash: {},
      },
      Actions: [
        {
          Parameters: { FlowLoggingBehavior: 'Enabled' },
          Identifier: 'enable-logging',
          Type: 'UpdateFlowLoggingBehavior',
          Transitions: { NextAction: 'initial-wait' },
        },
        {
          Parameters: { TimeLimitSeconds: '1' },
          Identifier: 'initial-wait',
          Type: 'Wait',
          Transitions: {
            NextAction: 'start-loop',
            Conditions: [
              { NextAction: 'start-loop', Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] } },
            ],
            Errors: [{ NextAction: 'start-loop', ErrorType: 'NoMatchingError' }],
          },
        },
        {
          Parameters: { LoopCount: '20' },
          Identifier: 'start-loop',
          Type: 'Loop',
          Transitions: {
            NextAction: 'invoke-lambda-ewt',
            Conditions: [
              { NextAction: 'invoke-lambda-ewt', Condition: { Operator: 'Equals', Operands: ['ContinueLooping'] } },
              { NextAction: 'invoke-lambda-ewt', Condition: { Operator: 'Equals', Operands: ['DoneLooping'] } },
            ],
          },
        },
        {
          Parameters: {
            LambdaFunctionARN: lambdaArn,
            InvocationTimeLimitSeconds: '8',
            InvocationType: 'SYNCHRONOUS',
            ResponseValidation: { ResponseType: 'STRING_MAP' },
          },
          Identifier: 'invoke-lambda-ewt',
          Type: 'InvokeLambdaFunction',
          Transitions: {
            NextAction: 'check-position',
            Errors: [{ NextAction: 'announce-fallback', ErrorType: 'NoMatchingError' }],
          },
        },
        {
          Parameters: { ComparisonValue: '$.External.PositionInQueue' },
          Identifier: 'check-position',
          Type: 'Compare',
          Transitions: {
            NextAction: 'announce-with-position',
            Conditions: [
              { NextAction: 'announce-without-position', Condition: { Operator: 'Equals', Operands: ['unknown'] } },
            ],
            Errors: [{ NextAction: 'announce-with-position', ErrorType: 'NoMatchingCondition' }],
          },
        },
        {
          Parameters: {
            SkipWhenDTMFBufferEnabled: 'false',
            Text:
              'Thank you for waiting. You are number $.External.PositionInQueue in the queue. ' +
              'Your estimated wait time is approximately $.External.EstimatedWaitTimeDisplay.',
          },
          Identifier: 'announce-with-position',
          Type: 'MessageParticipant',
          Transitions: {
            NextAction: 'wait-interval',
            Errors: [{ NextAction: 'wait-interval', ErrorType: 'NoMatchingError' }],
          },
        },
        {
          Parameters: {
            SkipWhenDTMFBufferEnabled: 'false',
            Text:
              'Thank you for waiting. We are checking your position. ' +
              'Your estimated wait time is approximately $.External.EstimatedWaitTimeDisplay.',
          },
          Identifier: 'announce-without-position',
          Type: 'MessageParticipant',
          Transitions: {
            NextAction: 'wait-interval',
            Errors: [{ NextAction: 'wait-interval', ErrorType: 'NoMatchingError' }],
          },
        },
        {
          Parameters: {
            SkipWhenDTMFBufferEnabled: 'false',
            Text: 'Thank you for your patience. An agent will be with you shortly.',
          },
          Identifier: 'announce-fallback',
          Type: 'MessageParticipant',
          Transitions: {
            NextAction: 'wait-interval',
            Errors: [{ NextAction: 'wait-interval', ErrorType: 'NoMatchingError' }],
          },
        },
        {
          Parameters: { TimeLimitSeconds: '30' },
          Identifier: 'wait-interval',
          Type: 'Wait',
          Transitions: {
            NextAction: 'start-loop',
            Conditions: [
              { NextAction: 'invoke-lambda-ewt', Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] } },
            ],
            Errors: [{ NextAction: 'start-loop', ErrorType: 'NoMatchingError' }],
          },
        },
      ],
    };

    return JSON.stringify(flow);
  }
}
