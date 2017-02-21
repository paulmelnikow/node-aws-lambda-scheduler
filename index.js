'use strict';

const pify = require('pify');
const AWS = require('aws-sdk');
const _ = require('underscore');
const c = require('rho-cc-promise').mixin(require('rho-contracts-fork'));


const cc = {};

cc.awsRegion = require('rho-cc-aws-region');

cc.lambdaSchedulerConfig = c.toContract({

  region: cc.awsRegion,

  accessKeyId: c.optional(c.string),
  secretAccessKey: c.optional(c.string),
  sessionToken: c.optional(c.string),

  functionName: c.string
    .doc('The name of the Lambda function being scheduled'),

  ruleName: c.string
    .doc("A name for the CloudWatch Events rule, e.g. '10am'"),

  scheduleExpression: c.string
    .doc('http://docs.aws.amazon.com/lambda/latest/dg/tutorial-scheduled-events-schedule-expressions.html'),

}).rename('lambdaSchedulerConfig');

cc.ruleArn = c.string.rename('ruleArn');

cc.lambdaScheduler = c.fun({ config: cc.lambdaSchedulerConfig })
    .constructs({

      updateEvent: c.fun()
        .returnsPromise(cc.ruleArn),

      authorizeRule: c.fun({ ruleArn: cc.ruleArn })
        .returnsPromise(c.value(undefined)),

      updateEventTarget: c.fun()
        .returnsPromise(c.object),

      schedule: c.fun()
        .returnsPromise(c.value(undefined)),

    });

class LambdaSchedulerImpl {

  constructor (config) {
    const awsAttrs = _(config).pick(
      'region', 'secretKeyId', 'secretAccessKey', 'secretToken');

    this.cloudWatchEvents = new AWS.CloudWatchEvents(awsAttrs);
    this.lambda = new AWS.Lambda(awsAttrs);

    this.functionName = config.functionName;
    this.ruleName = config.ruleName;
    this.scheduleExpression = config.scheduleExpression;
  }

    // Update the CloudWatch Events rule and return its ARN via promise.
  updateEvent () {
    const cloudWatchEvents = this.cloudWatchEvents;
    const listRules = pify(cloudWatchEvents.listRules.bind(cloudWatchEvents));
    const putRule = pify(cloudWatchEvents.putRule.bind(cloudWatchEvents));

    const ruleAttrs = {
      Name: this.ruleName,
      ScheduleExpression: this.scheduleExpression,
    };

    return listRules({})
      .then(rules => {
        const matching = _(rules.Rules).findWhere(ruleAttrs);

        if (matching) {
          return matching.Arn;
        } else {
          return putRule(ruleAttrs).then(data => data.RuleArn);
        }
      });
  }

  authorizeRule (ruleArn) {
    const addPermission = pify(this.lambda.addPermission.bind(this.lambda));

    const permissionAttrs = {
      FunctionName: this.functionName,
      StatementId: 'InvokeFromCloudWatchEvent',
      Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com',
      SourceArn: ruleArn,
    };

    return addPermission(permissionAttrs)
      .catch(err => {
        if (err.code !== 'ResourceConflictException') {
          throw err;
        }

          // A conflict means there is already a statement in place with
          // the ID 'InvokeFromCloudWatchEvent'. We're going to assume
          // this is a rule we have created during a previous deploy which
          // is still in effect.
      });
  }

  _getFunctionArn () {
    const getFunction = pify(this.lambda.getFunction.bind(this.lambda));

    return getFunction({ FunctionName: this.functionName })
      .then(functionData => functionData.Configuration.FunctionArn);
  }

  updateEventTarget () {
    const cloudWatchEvents = this.cloudWatchEvents;
    const putTargets = pify(cloudWatchEvents.putTargets.bind(cloudWatchEvents));

    this._getFunctionArn()
      .then(functionArn => {
        const targetAttrs = {
          Rule: this.ruleName,
          Targets: [{ Id: '1', Arn: functionArn }],
        };

        return putTargets(targetAttrs);
      });
  }

  schedule () {
    return this.updateEvent()
      .then(ruleArn => this.authorizeRule(ruleArn))
      .then(() => this.updateEventTarget());
  }

}

exports.LambdaScheduler = cc.lambdaScheduler.wrap(LambdaSchedulerImpl);
