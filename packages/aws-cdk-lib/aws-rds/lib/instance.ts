import { Construct } from 'constructs';
import { CaCertificate } from './ca-certificate';
import { DatabaseInsightsMode } from './database-insights-mode';
import { DatabaseSecret } from './database-secret';
import { Endpoint } from './endpoint';
import { IInstanceEngine } from './instance-engine';
import { IOptionGroup } from './option-group';
import { IParameterGroup, ParameterGroup } from './parameter-group';
import { applyDefaultRotationOptions, defaultDeletionProtection, engineDescription, renderCredentials, setupS3ImportExport, helperRemovalPolicy, renderUnless } from './private/util';
import { Credentials, EngineLifecycleSupport, PerformanceInsightRetention, RotationMultiUserOptions, RotationSingleUserOptions, SnapshotCredentials } from './props';
import { DatabaseProxy, DatabaseProxyOptions, ProxyTarget } from './proxy';
import { CfnDBInstance, CfnDBInstanceProps } from './rds.generated';
import { ISubnetGroup, SubnetGroup } from './subnet-group';
import { validateDatabaseInstanceProps } from './validate-database-insights';
import * as ec2 from '../../aws-ec2';
import * as events from '../../aws-events';
import * as iam from '../../aws-iam';
import * as kms from '../../aws-kms';
import * as logs from '../../aws-logs';
import * as s3 from '../../aws-s3';
import * as secretsmanager from '../../aws-secretsmanager';
import * as cxschema from '../../cloud-assembly-schema';
import { ArnComponents, ArnFormat, ContextProvider, Duration, FeatureFlags, IResource, Lazy, RemovalPolicy, Resource, Stack, Token, Tokenization } from '../../core';
import { ValidationError } from '../../core/lib/errors';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';
import * as cxapi from '../../cx-api';

/**
 * A database instance
 */
export interface IDatabaseInstance extends IResource, ec2.IConnectable, secretsmanager.ISecretAttachmentTarget {
  /**
   * The instance identifier.
   */
  readonly instanceIdentifier: string;

  /**
   * The instance arn.
   */
  readonly instanceArn: string;

  /**
   * The instance endpoint address.
   *
   * @attribute EndpointAddress
   */
  readonly dbInstanceEndpointAddress: string;

  /**
   * The instance endpoint port.
   *
   * @attribute EndpointPort
   */
  readonly dbInstanceEndpointPort: string;

  /**
   * The AWS Region-unique, immutable identifier for the DB instance.
   * This identifier is found in AWS CloudTrail log entries whenever the AWS KMS key for the DB instance is accessed.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbinstance.html#aws-resource-rds-dbinstance-return-values
   */
  readonly instanceResourceId?: string;

  /**
   * The instance endpoint.
   */
  readonly instanceEndpoint: Endpoint;

  /**
   * The engine of this database Instance.
   * May be not known for imported Instances if it wasn't provided explicitly,
   * or for read replicas.
   */
  readonly engine?: IInstanceEngine;

  /**
   * Add a new db proxy to this instance.
   */
  addProxy(id: string, options: DatabaseProxyOptions): DatabaseProxy;

  /**
   * Grant the given identity connection access to the database.
   *
   * @param grantee the Principal to grant the permissions to
   * @param dbUser the name of the database user to allow connecting as to the db instance
   */
  grantConnect(grantee: iam.IGrantable, dbUser?: string): iam.Grant;

  /**
   * Defines a CloudWatch event rule which triggers for instance events. Use
   * `rule.addEventPattern(pattern)` to specify a filter.
   */
  onEvent(id: string, options?: events.OnEventOptions): events.Rule;
}

/**
 * Properties that describe an existing instance
 */
export interface DatabaseInstanceAttributes {
  /**
   * The instance identifier.
   */
  readonly instanceIdentifier: string;

  /**
   * The endpoint address.
   */
  readonly instanceEndpointAddress: string;

  /**
   * The database port.
   */
  readonly port: number;

  /**
   * The AWS Region-unique, immutable identifier for the DB instance.
   * This identifier is found in AWS CloudTrail log entries whenever the AWS KMS key for the DB instance is accessed.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbinstance.html#aws-resource-rds-dbinstance-return-values
   */
  readonly instanceResourceId?: string;

  /**
   * The security groups of the instance.
   */
  readonly securityGroups: ec2.ISecurityGroup[];

  /**
   * The engine of the existing database Instance.
   *
   * @default - the imported Instance's engine is unknown
   */
  readonly engine?: IInstanceEngine;
}

/**
 * A new or imported database instance.
 */
export abstract class DatabaseInstanceBase extends Resource implements IDatabaseInstance {
  /**
   * Lookup an existing DatabaseInstance using instanceIdentifier.
   */
  public static fromLookup(scope: Construct, id: string, options: DatabaseInstanceLookupOptions): IDatabaseInstance {
    const response: {[key: string]: any}[] = ContextProvider.getValue(scope, {
      provider: cxschema.ContextProvider.CC_API_PROVIDER,
      props: {
        typeName: 'AWS::RDS::DBInstance',
        exactIdentifier: options.instanceIdentifier,
        propertiesToReturn: [
          'DBInstanceArn',
          'Endpoint.Address',
          'Endpoint.Port',
          'DbiResourceId',
          'DBSecurityGroups',
        ],
      } as cxschema.CcApiContextQuery,
      dummyValue: [
        {
          'Identifier': 'TEST',
          'DBInstanceArn': 'TESTARN',
          'Endpoint.Address': 'TESTADDRESS',
          'Endpoint.Port': '5432',
          'DbiResourceId': 'TESTID',
          'DBSecurityGroups': [],
        },
      ],
    }).value;

    // getValue returns a list of result objects.  We are expecting 1 result or Error.
    const instance = response[0];

    // Get ISecurityGroup from securityGroupId
    let securityGroups: ec2.ISecurityGroup[] = [];
    const dbsg: string[] = instance.DBSecurityGroups;
    if (dbsg) {
      securityGroups = dbsg.map(securityGroupId => {
        return ec2.SecurityGroup.fromSecurityGroupId(
          scope,
          `LSG-${securityGroupId}`,
          securityGroupId,
        );
      });
    }

    return this.fromDatabaseInstanceAttributes(scope, id, {
      instanceEndpointAddress: instance['Endpoint.Address'],
      port: instance['Endpoint.Port'],
      instanceIdentifier: options.instanceIdentifier,
      securityGroups: securityGroups,
      instanceResourceId: instance.DbiResourceId,
    });
  }

  /**
   * Import an existing database instance.
   */
  public static fromDatabaseInstanceAttributes(scope: Construct, id: string, attrs: DatabaseInstanceAttributes): IDatabaseInstance {
    class Import extends DatabaseInstanceBase implements IDatabaseInstance {
      public readonly defaultPort = ec2.Port.tcp(attrs.port);
      public readonly connections = new ec2.Connections({
        securityGroups: attrs.securityGroups,
        defaultPort: this.defaultPort,
      });
      public readonly instanceIdentifier = attrs.instanceIdentifier;
      public readonly dbInstanceEndpointAddress = attrs.instanceEndpointAddress;
      public readonly dbInstanceEndpointPort = Tokenization.stringifyNumber(attrs.port);
      public readonly instanceEndpoint = new Endpoint(attrs.instanceEndpointAddress, attrs.port);
      public readonly engine = attrs.engine;
      protected enableIamAuthentication = true;
      public readonly instanceResourceId = attrs.instanceResourceId;
    }

    return new Import(scope, id);
  }

  public abstract readonly instanceIdentifier: string;
  public abstract readonly dbInstanceEndpointAddress: string;
  public abstract readonly dbInstanceEndpointPort: string;
  public abstract readonly instanceResourceId?: string;
  public abstract readonly instanceEndpoint: Endpoint;
  // only required because of JSII bug: https://github.com/aws/jsii/issues/2040
  public abstract readonly engine?: IInstanceEngine;
  protected abstract enableIamAuthentication?: boolean;

  /**
   * Access to network connections.
   */
  public abstract readonly connections: ec2.Connections;

  /**
   * Add a new db proxy to this instance.
   */
  public addProxy(id: string, options: DatabaseProxyOptions): DatabaseProxy {
    return new DatabaseProxy(this, id, {
      proxyTarget: ProxyTarget.fromInstance(this),
      ...options,
    });
  }

  public grantConnect(grantee: iam.IGrantable, dbUser?: string): iam.Grant {
    if (this.enableIamAuthentication === false) {
      throw new ValidationError('Cannot grant connect when IAM authentication is disabled', this);
    }

    if (!this.instanceResourceId) {
      throw new ValidationError('For imported Database Instances, instanceResourceId is required to grantConnect()', this);
    }

    if (!dbUser) {
      throw new ValidationError('For imported Database Instances, the dbUser is required to grantConnect()', this);
    }

    this.enableIamAuthentication = true;
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['rds-db:connect'],
      resourceArns: [
        // The ARN of an IAM policy for IAM database access is not the same as the instance ARN, so we cannot use `this.instanceArn`.
        // See https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html
        Stack.of(this).formatArn({
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          service: 'rds-db',
          resource: 'dbuser',
          resourceName: [this.instanceResourceId, dbUser].join('/'),
        }),
      ],
    });
  }

  /**
   * Defines a CloudWatch event rule which triggers for instance events. Use
   * `rule.addEventPattern(pattern)` to specify a filter.
   */
  public onEvent(id: string, options: events.OnEventOptions = {}) {
    const rule = new events.Rule(this, id, options);
    rule.addEventPattern({
      source: ['aws.rds'],
      resources: [this.instanceArn],
    });
    rule.addTarget(options.target);
    return rule;
  }

  /**
   * The instance arn.
   */
  public get instanceArn(): string {
    const commonAnComponents: ArnComponents = {
      service: 'rds',
      resource: 'db',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    };
    const localArn = Stack.of(this).formatArn({
      ...commonAnComponents,
      resourceName: this.instanceIdentifier,
    });
    return this.getResourceArnAttribute(localArn, {
      ...commonAnComponents,
      resourceName: this.physicalName,
    });
  }

  /**
   * Renders the secret attachment target specifications.
   */
  public asSecretAttachmentTarget(): secretsmanager.SecretAttachmentTargetProps {
    return {
      targetId: this.instanceIdentifier,
      targetType: secretsmanager.AttachmentTargetType.RDS_DB_INSTANCE,
    };
  }
}

/**
 * The license model.
 */
export enum LicenseModel {
  /**
   * License included.
   */
  LICENSE_INCLUDED = 'license-included',

  /**
   * Bring your own license.
   */
  BRING_YOUR_OWN_LICENSE = 'bring-your-own-license',

  /**
   * General public license.
   */
  GENERAL_PUBLIC_LICENSE = 'general-public-license',
}

/**
 * The processor features.
 */
export interface ProcessorFeatures {
  /**
   * The number of CPU core.
   *
   * @default - the default number of CPU cores for the chosen instance class.
   */
  readonly coreCount?: number;

  /**
   * The number of threads per core.
   *
   * @default - the default number of threads per core for the chosen instance class.
   */
  readonly threadsPerCore?: number;
}

/**
 * The type of storage.
 *
 * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html
 */
export enum StorageType {
  /**
   * Standard.
   *
   * Amazon RDS supports magnetic storage for backward compatibility. It is recommended to use
   * General Purpose SSD or Provisioned IOPS SSD for any new storage needs.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#CHAP_Storage.Magnetic
   */
  STANDARD = 'standard',

  /**
   * General purpose SSD (gp2).
   *
   * Baseline performance determined by volume size
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#Concepts.Storage.GeneralSSD
   */
  GP2 = 'gp2',

  /**
   * General purpose SSD (gp3).
   *
   * Performance scales independently from storage
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#Concepts.Storage.GeneralSSD
   */
  GP3 = 'gp3',

  /**
   * Provisioned IOPS SSD (io1).
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#USER_PIOPS
   */
  IO1 = 'io1',

  /**
   * Provisioned IOPS SSD (io2).
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#USER_PIOPS
   */
  IO2 = 'io2',
}

/**
 * The network type of the DB instance.
 */
export enum NetworkType {
  /**
   * IPv4 only network type.
   */
  IPV4 = 'IPV4',

  /**
   * Dual-stack network type.
   */
  DUAL = 'DUAL',
}

/**
 * Construction properties for a DatabaseInstanceNew
 */
export interface DatabaseInstanceNewProps {
  /**
   * Specifies if the database instance is a multiple Availability Zone deployment.
   *
   * @default false
   */
  readonly multiAz?: boolean;

  /**
   * The name of the Availability Zone where the DB instance will be located.
   *
   * @default - no preference
   */
  readonly availabilityZone?: string;

  /**
   * The storage type. Storage types supported are gp2, io1, standard.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html#Concepts.Storage.GeneralSSD
   *
   * @default GP2
   */
  readonly storageType?: StorageType;

  /**
   * The storage throughput, specified in mebibytes per second (MiBps).
   *
   * Only applicable for GP3.
   *
   * @see https://docs.aws.amazon.com//AmazonRDS/latest/UserGuide/CHAP_Storage.html#gp3-storage
   *
   * @default - 125 MiBps if allocated storage is less than 400 GiB for MariaDB, MySQL, and PostgreSQL,
   * less than 200 GiB for Oracle and less than 20 GiB for SQL Server. 500 MiBps otherwise (except for
   * SQL Server where the default is always 125 MiBps).
   */
  readonly storageThroughput?: number;

  /**
   * The number of I/O operations per second (IOPS) that the database provisions.
   * The value must be equal to or greater than 1000.
   *
   * @default - no provisioned iops if storage type is not specified. For GP3: 3,000 IOPS if allocated
   * storage is less than 400 GiB for MariaDB, MySQL, and PostgreSQL, less than 200 GiB for Oracle and
   * less than 20 GiB for SQL Server. 12,000 IOPS otherwise (except for SQL Server where the default is
   * always 3,000 IOPS).
   */
  readonly iops?: number;

  /**
   * The number of CPU cores and the number of threads per core.
   *
   * @default - the default number of CPU cores and threads per core for the
   * chosen instance class.
   *
   * See https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.html#USER_ConfigureProcessor
   */
  readonly processorFeatures?: ProcessorFeatures;

  /**
   * A name for the DB instance. If you specify a name, AWS CloudFormation
   * converts it to lowercase.
   *
   * @default - a CloudFormation generated name
   */
  readonly instanceIdentifier?: string;

  /**
   * The VPC network where the DB subnet group should be created.
   */
  readonly vpc: ec2.IVpc;

  /**
   * The type of subnets to add to the created DB subnet group.
   *
   * @deprecated use `vpcSubnets`
   * @default - private subnets
   */
  readonly vpcPlacement?: ec2.SubnetSelection;

  /**
   * The type of subnets to add to the created DB subnet group.
   *
   * @default - private subnets
   */
  readonly vpcSubnets?: ec2.SubnetSelection;

  /**
   * The security groups to assign to the DB instance.
   *
   * @default - a new security group is created
   */
  readonly securityGroups?: ec2.ISecurityGroup[];

  /**
   * The port for the instance.
   *
   * @default - the default port for the chosen engine.
   */
  readonly port?: number;

  /**
   * The DB parameter group to associate with the instance.
   *
   * @default - no parameter group
   */
  readonly parameterGroup?: IParameterGroup;

  /**
   * The option group to associate with the instance.
   *
   * @default - no option group
   */
  readonly optionGroup?: IOptionGroup;

  /**
   * Whether to enable mapping of AWS Identity and Access Management (IAM) accounts
   * to database accounts.
   *
   * @default false
   */
  readonly iamAuthentication?: boolean;

  /**
   * The number of days during which automatic DB snapshots are retained.
   * Set to zero to disable backups.
   * When creating a read replica, you must enable automatic backups on the source
   * database instance by setting the backup retention to a value other than zero.
   *
   * @default - Duration.days(1) for source instances, disabled for read replicas
   */
  readonly backupRetention?: Duration;

  /**
   * The daily time range during which automated backups are performed.
   *
   * Constraints:
   * - Must be in the format `hh24:mi-hh24:mi`.
   * - Must be in Universal Coordinated Time (UTC).
   * - Must not conflict with the preferred maintenance window.
   * - Must be at least 30 minutes.
   *
   * @default - a 30-minute window selected at random from an 8-hour block of
   * time for each AWS Region. To see the time blocks available, see
   * https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html#USER_WorkingWithAutomatedBackups.BackupWindow
   */
  readonly preferredBackupWindow?: string;

  /**
   * Indicates whether to copy all of the user-defined tags from the
   * DB instance to snapshots of the DB instance.
   *
   * @default true
   */
  readonly copyTagsToSnapshot?: boolean;

  /**
   * Indicates whether automated backups should be deleted or retained when
   * you delete a DB instance.
   *
   * @default true
   */
  readonly deleteAutomatedBackups?: boolean;

  /**
   * The interval, in seconds, between points when Amazon RDS collects enhanced
   * monitoring metrics for the DB instance.
   *
   * @default - no enhanced monitoring
   */
  readonly monitoringInterval?: Duration;

  /**
   * Role that will be used to manage DB instance monitoring.
   *
   * @default - A role is automatically created for you
   */
  readonly monitoringRole?: iam.IRole;

  /**
   * Whether to enable Performance Insights for the DB instance.
   *
   * @default - false, unless ``performanceInsightRetention`` or ``performanceInsightEncryptionKey`` is set.
   */
  readonly enablePerformanceInsights?: boolean;

  /**
   * The amount of time, in days, to retain Performance Insights data.
   *
   * If you set `databaseInsightsMode` to `DatabaseInsightsMode.ADVANCED`, you must set this property to `PerformanceInsightRetention.MONTHS_15`.
   *
   * @default 7 this is the free tier
   */
  readonly performanceInsightRetention?: PerformanceInsightRetention;

  /**
   * The AWS KMS key for encryption of Performance Insights data.
   *
   * @default - default master key
   */
  readonly performanceInsightEncryptionKey?: kms.IKey;

  /**
   * The database insights mode.
   *
   * @default - DatabaseInsightsMode.STANDARD when performance insights are enabled, otherwise not set.
   */
  readonly databaseInsightsMode?: DatabaseInsightsMode;

  /**
   * The list of log types that need to be enabled for exporting to
   * CloudWatch Logs.
   *
   * @default - no log exports
   */
  readonly cloudwatchLogsExports?: string[];

  /**
   * The number of days log events are kept in CloudWatch Logs. When updating
   * this property, unsetting it doesn't remove the log retention policy. To
   * remove the retention policy, set the value to `Infinity`.
   *
   * @default - logs never expire
   */
  readonly cloudwatchLogsRetention?: logs.RetentionDays;

  /**
   * The IAM role for the Lambda function associated with the custom resource
   * that sets the retention policy.
   *
   * @default - a new role is created.
   */
  readonly cloudwatchLogsRetentionRole?: iam.IRole;

  /**
   * Indicates that minor engine upgrades are applied automatically to the
   * DB instance during the maintenance window.
   *
   * @default true
   */
  readonly autoMinorVersionUpgrade?: boolean;

  /**
   * The weekly time range (in UTC) during which system maintenance can occur.
   *
   * Format: `ddd:hh24:mi-ddd:hh24:mi`
   * Constraint: Minimum 30-minute window
   *
   * @default - a 30-minute window selected at random from an 8-hour block of
   * time for each AWS Region, occurring on a random day of the week. To see
   * the time blocks available, see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.Maintenance.html#Concepts.DBMaintenance
   */
  readonly preferredMaintenanceWindow?: string;

  /**
   * Indicates whether the DB instance should have deletion protection enabled.
   *
   * @default - true if ``removalPolicy`` is RETAIN, false otherwise
   */
  readonly deletionProtection?: boolean;

  /**
   * The CloudFormation policy to apply when the instance is removed from the
   * stack or replaced during an update.
   *
   * @default - RemovalPolicy.SNAPSHOT (remove the resource, but retain a snapshot of the data)
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Upper limit to which RDS can scale the storage in GiB(Gibibyte).
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.StorageTypes.html#USER_PIOPS.Autoscaling
   * @default - No autoscaling of RDS instance
   */
  readonly maxAllocatedStorage?: number;

  /**
   * The Active Directory directory ID to create the DB instance in.
   *
   * @default - Do not join domain
   */
  readonly domain?: string;

  /**
   * The IAM role to be used when making API calls to the Directory Service. The role needs the AWS-managed policy
   * AmazonRDSDirectoryServiceAccess or equivalent.
   *
   * @default - The role will be created for you if `DatabaseInstanceNewProps#domain` is specified
   */
  readonly domainRole?: iam.IRole;

  /**
   * Existing subnet group for the instance.
   *
   * @default - a new subnet group will be created.
   */
  readonly subnetGroup?: ISubnetGroup;

  /**
   * Role that will be associated with this DB instance to enable S3 import.
   * This feature is only supported by the Microsoft SQL Server, Oracle, and PostgreSQL engines.
   *
   * This property must not be used if `s3ImportBuckets` is used.
   *
   * For Microsoft SQL Server:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/SQLServer.Procedural.Importing.html
   * For Oracle:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/oracle-s3-integration.html
   * For PostgreSQL:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Procedural.Importing.html
   *
   * @default - New role is created if `s3ImportBuckets` is set, no role is defined otherwise
   */
  readonly s3ImportRole?: iam.IRole;

  /**
   * S3 buckets that you want to load data from.
   * This feature is only supported by the Microsoft SQL Server, Oracle, and PostgreSQL engines.
   *
   * This property must not be used if `s3ImportRole` is used.
   *
   * For Microsoft SQL Server:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/SQLServer.Procedural.Importing.html
   * For Oracle:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/oracle-s3-integration.html
   * For PostgreSQL:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Procedural.Importing.html
   *
   * @default - None
   */
  readonly s3ImportBuckets?: s3.IBucket[];

  /**
   * Role that will be associated with this DB instance to enable S3 export.
   *
   * This property must not be used if `s3ExportBuckets` is used.
   *
   * For Microsoft SQL Server:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/SQLServer.Procedural.Importing.html
   * For Oracle:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/oracle-s3-integration.html
   *
   * @default - New role is created if `s3ExportBuckets` is set, no role is defined otherwise
   */
  readonly s3ExportRole?: iam.IRole;

  /**
   * S3 buckets that you want to load data into.
   *
   * This property must not be used if `s3ExportRole` is used.
   *
   * For Microsoft SQL Server:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/SQLServer.Procedural.Importing.html
   * For Oracle:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/oracle-s3-integration.html
   *
   * @default - None
   */
  readonly s3ExportBuckets?: s3.IBucket[];

  /**
   * Indicates whether the DB instance is an internet-facing instance. If not specified,
   * the instance's vpcSubnets will be used to determine if the instance is internet-facing
   * or not.
   *
   * @default - `true` if the instance's `vpcSubnets` is `subnetType: SubnetType.PUBLIC`, `false` otherwise
   */
  readonly publiclyAccessible?: boolean;

  /**
   * The network type of the DB instance.
   *
   * @default - IPV4
   */
  readonly networkType?: NetworkType;

  /**
   * The identifier of the CA certificate for this DB instance.
   *
   * Specifying or updating this property triggers a reboot.
   *
   * For RDS DB engines:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL-certificate-rotation.html
   * For Aurora DB engines:
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.SSL-certificate-rotation.html
   *
   * @default - RDS will choose a certificate authority
   */
  readonly caCertificate?: CaCertificate;

  /**
   * Specifies whether changes to the DB instance and any pending modifications are applied immediately, regardless of the `preferredMaintenanceWindow` setting.
   * If set to `false`, changes are applied during the next maintenance window.
   *
   * Until RDS applies the changes, the DB instance remains in a drift state.
   * As a result, the configuration doesn't fully reflect the requested modifications and temporarily diverges from the intended state.
   *
   * This property also determines whether the DB instance reboots when a static parameter is modified in the associated DB parameter group.
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.Modifying.html
   *
   * @default - Changes will be applied immediately
   */
  readonly applyImmediately?: boolean;

  /**
   * The life cycle type for this DB instance.
   * This setting applies only to RDS for MySQL and RDS for PostgreSQL.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support.html
   *
   * @default undefined - AWS RDS default setting is `EngineLifecycleSupport.OPEN_SOURCE_RDS_EXTENDED_SUPPORT`
   */
  readonly engineLifecycleSupport?: EngineLifecycleSupport;
}

/**
 * A new database instance.
 */
abstract class DatabaseInstanceNew extends DatabaseInstanceBase implements IDatabaseInstance {
  /**
   * The VPC where this database instance is deployed.
   */
  public readonly vpc: ec2.IVpc;

  public readonly connections: ec2.Connections;

  /**
   * The log group is created when `cloudwatchLogsExports` is set.
   *
   * Each export value will create a separate log group.
   */
  public readonly cloudwatchLogGroups: {[engine: string]: logs.ILogGroup};

  protected abstract readonly instanceType: ec2.InstanceType;

  protected readonly vpcPlacement?: ec2.SubnetSelection;
  protected readonly newCfnProps: CfnDBInstanceProps;

  private readonly cloudwatchLogsExports?: string[];
  private readonly cloudwatchLogsRetention?: logs.RetentionDays;
  private readonly cloudwatchLogsRetentionRole?: iam.IRole;

  private readonly domainId?: string;
  private readonly domainRole?: iam.IRole;

  protected enableIamAuthentication?: boolean;

  constructor(scope: Construct, id: string, props: DatabaseInstanceNewProps) {
    // RDS always lower-cases the ID of the database, so use that for the physical name
    // (which is the name used for cross-environment access, so it needs to be correct,
    // regardless of the feature flag that changes it in the template for the L1)
    const instancePhysicalName = Token.isUnresolved(props.instanceIdentifier)
      ? props.instanceIdentifier
      : props.instanceIdentifier?.toLowerCase();
    super(scope, id, {
      physicalName: instancePhysicalName,
    });

    this.vpc = props.vpc;
    if (props.vpcSubnets && props.vpcPlacement) {
      throw new ValidationError('Only one of `vpcSubnets` or `vpcPlacement` can be specified', this);
    }
    this.vpcPlacement = props.vpcSubnets ?? props.vpcPlacement;

    if (props.multiAz === true && props.availabilityZone) {
      throw new ValidationError('Requesting a specific availability zone is not valid for Multi-AZ instances', this);
    }

    const subnetGroup = props.subnetGroup ?? new SubnetGroup(this, 'SubnetGroup', {
      description: `Subnet group for ${this.node.id} database`,
      vpc: this.vpc,
      vpcSubnets: this.vpcPlacement,
      removalPolicy: renderUnless(helperRemovalPolicy(props.removalPolicy), RemovalPolicy.DESTROY),
    });

    const securityGroups = props.securityGroups || [new ec2.SecurityGroup(this, 'SecurityGroup', {
      description: `Security group for ${this.node.id} database`,
      vpc: props.vpc,
    })];

    this.connections = new ec2.Connections({
      securityGroups,
      defaultPort: ec2.Port.tcp(Lazy.number({ produce: () => this.instanceEndpoint.port })),
    });

    let monitoringRole;
    if (props.monitoringInterval && props.monitoringInterval.toSeconds()) {
      monitoringRole = props.monitoringRole || new iam.Role(this, 'MonitoringRole', {
        assumedBy: new iam.ServicePrincipal('monitoring.rds.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole')],
      });
    }

    const storageType = props.storageType ?? StorageType.GP2;
    const iops = defaultIops(storageType, props.iops);
    if (props.storageThroughput && storageType !== StorageType.GP3) {
      throw new ValidationError(`The storage throughput can only be specified with GP3 storage type. Got ${storageType}.`, this);
    }
    if (storageType === StorageType.GP3 && props.storageThroughput && iops
        && !Token.isUnresolved(props.storageThroughput) && !Token.isUnresolved(iops)
        && props.storageThroughput/iops > 0.25) {
      throw new ValidationError(`The maximum ratio of storage throughput to IOPS is 0.25. Got ${props.storageThroughput/iops}.`, this);
    }

    this.cloudwatchLogGroups = {};
    this.cloudwatchLogsExports = props.cloudwatchLogsExports;
    this.cloudwatchLogsRetention = props.cloudwatchLogsRetention;
    this.cloudwatchLogsRetentionRole = props.cloudwatchLogsRetentionRole;
    this.enableIamAuthentication = props.iamAuthentication;

    const enablePerformanceInsights = props.enablePerformanceInsights
      || props.performanceInsightRetention !== undefined
      || props.performanceInsightEncryptionKey !== undefined
      || props.databaseInsightsMode === DatabaseInsightsMode.ADVANCED;

    if (props.domain) {
      this.domainId = props.domain;
      this.domainRole = props.domainRole || new iam.Role(this, 'RDSDirectoryServiceRole', {
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('rds.amazonaws.com'),
          new iam.ServicePrincipal('directoryservice.rds.amazonaws.com'),
        ),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSDirectoryServiceAccess'),
        ],
      });
    }

    const maybeLowercasedInstanceId = FeatureFlags.of(this).isEnabled(cxapi.RDS_LOWERCASE_DB_IDENTIFIER)
    && !Token.isUnresolved(props.instanceIdentifier)
      ? props.instanceIdentifier?.toLowerCase()
      : props.instanceIdentifier;

    const instanceParameterGroupConfig = props.parameterGroup?.bindToInstance({});
    const isInPublicSubnet = this.vpcPlacement && this.vpcPlacement.subnetType === ec2.SubnetType.PUBLIC;
    this.newCfnProps = {
      autoMinorVersionUpgrade: props.autoMinorVersionUpgrade,
      availabilityZone: props.multiAz ? undefined : props.availabilityZone,
      backupRetentionPeriod: props.backupRetention?.toDays(),
      copyTagsToSnapshot: props.copyTagsToSnapshot ?? true,
      dbInstanceClass: Lazy.string({ produce: () => `db.${this.instanceType}` }),
      dbInstanceIdentifier: Token.isUnresolved(props.instanceIdentifier)
        // if the passed identifier is a Token,
        // we need to use the physicalName of the database
        // (we cannot change its case anyway),
        // as it might be used in a cross-environment fashion
        ? this.physicalName
        : maybeLowercasedInstanceId,
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      deleteAutomatedBackups: props.deleteAutomatedBackups,
      deletionProtection: defaultDeletionProtection(props.deletionProtection, props.removalPolicy),
      enableCloudwatchLogsExports: this.cloudwatchLogsExports,
      enableIamDatabaseAuthentication: Lazy.any({ produce: () => this.enableIamAuthentication }),
      enablePerformanceInsights: enablePerformanceInsights || props.enablePerformanceInsights, // fall back to undefined if not set,
      iops,
      monitoringInterval: props.monitoringInterval?.toSeconds(),
      monitoringRoleArn: monitoringRole?.roleArn,
      multiAz: props.multiAz,
      dbParameterGroupName: instanceParameterGroupConfig?.parameterGroupName,
      optionGroupName: props.optionGroup?.optionGroupName,
      performanceInsightsKmsKeyId: props.performanceInsightEncryptionKey?.keyArn,
      performanceInsightsRetentionPeriod: enablePerformanceInsights
        ? (props.performanceInsightRetention || PerformanceInsightRetention.DEFAULT)
        : undefined,
      databaseInsightsMode: props.databaseInsightsMode,
      port: props.port !== undefined ? Tokenization.stringifyNumber(props.port) : undefined,
      preferredBackupWindow: props.preferredBackupWindow,
      preferredMaintenanceWindow: props.preferredMaintenanceWindow,
      processorFeatures: props.processorFeatures && renderProcessorFeatures(props.processorFeatures),
      publiclyAccessible: props.publiclyAccessible ?? isInPublicSubnet,
      storageType,
      storageThroughput: props.storageThroughput,
      vpcSecurityGroups: securityGroups.map(s => s.securityGroupId),
      maxAllocatedStorage: props.maxAllocatedStorage,
      domain: this.domainId,
      domainIamRoleName: this.domainRole?.roleName,
      networkType: props.networkType,
      caCertificateIdentifier: props.caCertificate ? props.caCertificate.toString() : undefined,
      applyImmediately: props.applyImmediately,
      engineLifecycleSupport: props.engineLifecycleSupport,
    };
  }

  protected setLogRetention() {
    if (this.cloudwatchLogsExports && this.cloudwatchLogsRetention) {
      for (const log of this.cloudwatchLogsExports) {
        const logGroupName = `/aws/rds/instance/${this.instanceIdentifier}/${log}`;
        new logs.LogRetention(this, `LogRetention${log}`, {
          logGroupName,
          retention: this.cloudwatchLogsRetention,
          role: this.cloudwatchLogsRetentionRole,
        });
        this.cloudwatchLogGroups[log] = logs.LogGroup.fromLogGroupName(this, `LogGroup${this.instanceIdentifier}${log}`, logGroupName);
      }
    }
  }
}

/**
 * Construction properties for a DatabaseInstanceSource
 */
export interface DatabaseInstanceSourceProps extends DatabaseInstanceNewProps {
  /**
   * The database engine.
   */
  readonly engine: IInstanceEngine;

  /**
   * The name of the compute and memory capacity for the instance.
   *
   * @default - m5.large (or, more specifically, db.m5.large)
   */
  readonly instanceType?: ec2.InstanceType;

  /**
   * The license model.
   *
   * @default - RDS default license model
   */
  readonly licenseModel?: LicenseModel;

  /**
   * Whether to allow major version upgrades.
   *
   * @default false
   */
  readonly allowMajorVersionUpgrade?: boolean;

  /**
   * The time zone of the instance. This is currently supported only by Microsoft Sql Server.
   *
   * @default - RDS default timezone
   */
  readonly timezone?: string;

  /**
   * The allocated storage size, specified in gibibytes (GiB).
   *
   * @default 100
   */
  readonly allocatedStorage?: number;

  /**
   * The name of the database.
   *
   * @default - no name
   */
  readonly databaseName?: string;

  /**
   * The parameters in the DBParameterGroup to create automatically
   *
   * You can only specify parameterGroup or parameters but not both.
   * You need to use a versioned engine to auto-generate a DBParameterGroup.
   *
   * @default - None
   */
  readonly parameters?: { [key: string]: string };
}

/**
 * A new source database instance (not a read replica)
 */
abstract class DatabaseInstanceSource extends DatabaseInstanceNew implements IDatabaseInstance {
  public readonly engine?: IInstanceEngine;
  /**
   * The AWS Secrets Manager secret attached to the instance.
   */
  public abstract readonly secret?: secretsmanager.ISecret;

  protected readonly sourceCfnProps: CfnDBInstanceProps;
  protected readonly instanceType: ec2.InstanceType;

  private readonly singleUserRotationApplication: secretsmanager.SecretRotationApplication;
  private readonly multiUserRotationApplication: secretsmanager.SecretRotationApplication;

  constructor(scope: Construct, id: string, props: DatabaseInstanceSourceProps) {
    super(scope, id, props);

    this.singleUserRotationApplication = props.engine.singleUserRotationApplication;
    this.multiUserRotationApplication = props.engine.multiUserRotationApplication;
    this.engine = props.engine;

    const engineType = props.engine.engineType;

    if (props.engineLifecycleSupport && !['mysql', 'postgres'].includes(engineType)) {
      throw new ValidationError(`'engineLifecycleSupport' can only be specified for RDS for MySQL and RDS for PostgreSQL, got: '${engineType}'`, this);
    }

    // only Oracle and SQL Server require the import and export Roles to be the same
    const combineRoles = engineType.startsWith('oracle-') || engineType.startsWith('sqlserver-');
    let { s3ImportRole, s3ExportRole } = setupS3ImportExport(this, props, combineRoles);
    const engineConfig = props.engine.bindToInstance(this, {
      ...props,
      s3ImportRole,
      s3ExportRole,
    });

    const instanceAssociatedRoles: CfnDBInstance.DBInstanceRoleProperty[] = [];
    const engineFeatures = engineConfig.features;
    if (s3ImportRole) {
      if (!engineFeatures?.s3Import) {
        throw new ValidationError(`Engine '${engineDescription(props.engine)}' does not support S3 import`, this);
      }
      instanceAssociatedRoles.push({ roleArn: s3ImportRole.roleArn, featureName: engineFeatures?.s3Import });
    }
    if (s3ExportRole) {
      if (!engineFeatures?.s3Export) {
        throw new ValidationError(`Engine '${engineDescription(props.engine)}' does not support S3 export`, this);
      }
      // only add the export feature if it's different from the import feature
      if (engineFeatures.s3Import !== engineFeatures?.s3Export) {
        instanceAssociatedRoles.push({ roleArn: s3ExportRole.roleArn, featureName: engineFeatures?.s3Export });
      }
    }

    this.instanceType = props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE);

    if (props.parameterGroup && props.parameters) {
      throw new ValidationError('You cannot specify both parameterGroup and parameters', this);
    }

    const dbParameterGroupName = props.parameters
      ? new ParameterGroup(this, 'ParameterGroup', {
        engine: props.engine,
        parameters: props.parameters,
      }).bindToInstance({}).parameterGroupName
      : this.newCfnProps.dbParameterGroupName;

    this.sourceCfnProps = {
      ...this.newCfnProps,
      associatedRoles: instanceAssociatedRoles.length > 0 ? instanceAssociatedRoles : undefined,
      optionGroupName: engineConfig.optionGroup?.optionGroupName,
      allocatedStorage: props.allocatedStorage?.toString() ?? '100',
      allowMajorVersionUpgrade: props.allowMajorVersionUpgrade,
      dbName: props.databaseName,
      engine: engineType,
      engineVersion: props.engine.engineVersion?.fullVersion,
      licenseModel: props.licenseModel,
      timezone: props.timezone,
      dbParameterGroupName,
    };
  }

  /**
   * Adds the single user rotation of the master password to this instance.
   *
   * @param options the options for the rotation,
   *                if you want to override the defaults
   */
  public addRotationSingleUser(options: RotationSingleUserOptions = {}): secretsmanager.SecretRotation {
    if (!this.secret) {
      throw new ValidationError('Cannot add single user rotation for an instance without secret.', this);
    }

    const id = 'RotationSingleUser';
    const existing = this.node.tryFindChild(id);
    if (existing) {
      throw new ValidationError('A single user rotation was already added to this instance.', this);
    }

    return new secretsmanager.SecretRotation(this, id, {
      ...applyDefaultRotationOptions(options, this.vpcPlacement),
      secret: this.secret,
      application: this.singleUserRotationApplication,
      vpc: this.vpc,
      target: this,
    });
  }

  /**
   * Adds the multi user rotation to this instance.
   */
  public addRotationMultiUser(id: string, options: RotationMultiUserOptions): secretsmanager.SecretRotation {
    if (!this.secret) {
      throw new ValidationError('Cannot add multi user rotation for an instance without secret.', this);
    }

    return new secretsmanager.SecretRotation(this, id, {
      ...applyDefaultRotationOptions(options, this.vpcPlacement),
      secret: options.secret,
      masterSecret: this.secret,
      application: this.multiUserRotationApplication,
      vpc: this.vpc,
      target: this,
    });
  }

  /**
   * Grant the given identity connection access to the database.
   *
   * @param grantee the Principal to grant the permissions to
   * @param dbUser the name of the database user to allow connecting as to the db instance,
   * or the default database user, obtained from the Secret, if not specified
   */
  public grantConnect(grantee: iam.IGrantable, dbUser?: string): iam.Grant {
    if (!dbUser) {
      if (!this.secret) {
        throw new ValidationError('A secret or dbUser is required to grantConnect()', this);
      }

      dbUser = this.secret.secretValueFromJson('username').unsafeUnwrap();
    }

    return super.grantConnect(grantee, dbUser);
  }
}

/**
 * Properties for looking up an existing DatabaseInstance.
 */
export interface DatabaseInstanceLookupOptions {
  /**
   * The instance identifier of the DatabaseInstance
   */
  readonly instanceIdentifier: string;
}

/**
 * Construction properties for a DatabaseInstance.
 */
export interface DatabaseInstanceProps extends DatabaseInstanceSourceProps {
  /**
   * Credentials for the administrative user
   *
   * @default - A username of 'admin' (or 'postgres' for PostgreSQL) and SecretsManager-generated password
   */
  readonly credentials?: Credentials;

  /**
   * For supported engines, specifies the character set to associate with the
   * DB instance.
   *
   * @default - RDS default character set name
   */
  readonly characterSetName?: string;

  /**
   * Indicates whether the DB instance is encrypted.
   *
   * @default - true if storageEncryptionKey has been provided, false otherwise
   */
  readonly storageEncrypted?: boolean;

  /**
   * The KMS key that's used to encrypt the DB instance.
   *
   * @default - default master key if storageEncrypted is true, no key otherwise
   */
  readonly storageEncryptionKey?: kms.IKey;
}

/**
 * A database instance
 *
 * @resource AWS::RDS::DBInstance
 */
@propertyInjectable
export class DatabaseInstance extends DatabaseInstanceSource implements IDatabaseInstance {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-rds.DatabaseInstance';

  public readonly instanceIdentifier: string;
  public readonly dbInstanceEndpointAddress: string;
  public readonly dbInstanceEndpointPort: string;
  public readonly instanceResourceId?: string;
  public readonly instanceEndpoint: Endpoint;
  public readonly secret?: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseInstanceProps) {
    super(scope, id, props);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    // Validate database instance props
    validateDatabaseInstanceProps(this, props);

    const credentials = renderCredentials(this, props.engine, props.credentials);
    const secret = credentials.secret;

    const instance = new CfnDBInstance(this, 'Resource', {
      ...this.sourceCfnProps,
      characterSetName: props.characterSetName,
      kmsKeyId: props.storageEncryptionKey && props.storageEncryptionKey.keyArn,
      masterUsername: credentials.username,
      masterUserPassword: credentials.password?.unsafeUnwrap(),
      storageEncrypted: props.storageEncryptionKey ? true : props.storageEncrypted,
    });

    this.instanceIdentifier = this.getResourceNameAttribute(instance.ref);
    this.dbInstanceEndpointAddress = instance.attrEndpointAddress;
    this.dbInstanceEndpointPort = instance.attrEndpointPort;
    this.instanceResourceId = instance.attrDbiResourceId;

    // create a number token that represents the port of the instance
    const portAttribute = Token.asNumber(instance.attrEndpointPort);
    this.instanceEndpoint = new Endpoint(instance.attrEndpointAddress, portAttribute);

    instance.applyRemovalPolicy(props.removalPolicy ?? RemovalPolicy.SNAPSHOT);

    if (secret) {
      this.secret = secret.attach(this);
    }

    this.setLogRetention();
  }
}

/**
 * Construction properties for a DatabaseInstanceFromSnapshot.
 */
export interface DatabaseInstanceFromSnapshotProps extends DatabaseInstanceSourceProps {
  /**
   * The name or Amazon Resource Name (ARN) of the DB snapshot that's used to
   * restore the DB instance. If you're restoring from a shared manual DB
   * snapshot, you must specify the ARN of the snapshot.
   * Constraints:
   *
   * - Can't be specified when `clusterSnapshotIdentifier` is specified.
   * - Must be specified when `clusterSnapshotIdentifier` isn't specified.
   *
   * @default - None
   */
  readonly snapshotIdentifier?: string;

  /**
   * The identifier for the Multi-AZ DB cluster snapshot to restore from.
   *
   * For more information on Multi-AZ DB clusters, see [Multi-AZ DB cluster deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts.html) in the *Amazon RDS User Guide* .
   *
   * Constraints:
   *
   * - Can't be specified when `snapshotIdentifier` is specified.
   * - Must be specified when `snapshotIdentifier` isn't specified.
   * - If you are restoring from a shared manual Multi-AZ DB cluster snapshot, the `clusterSnapshotIdentifier` must be the ARN of the shared snapshot.
   * - Can't be the identifier of an Aurora DB cluster snapshot.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromMultiAZDBClusterSnapshot.html
   * @default - None
   */
  readonly clusterSnapshotIdentifier?: string;

  /**
   * Master user credentials.
   *
   * Note - It is not possible to change the master username for a snapshot;
   * however, it is possible to provide (or generate) a new password.
   *
   * @default - The existing username and password from the snapshot will be used.
   */
  readonly credentials?: SnapshotCredentials;
}

/**
 * A database instance restored from a snapshot.
 *
 * @resource AWS::RDS::DBInstance
 */
@propertyInjectable
export class DatabaseInstanceFromSnapshot extends DatabaseInstanceSource implements IDatabaseInstance {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-rds.DatabaseInstanceFromSnapshot';

  public readonly instanceIdentifier: string;
  public readonly dbInstanceEndpointAddress: string;
  public readonly dbInstanceEndpointPort: string;
  public readonly instanceResourceId?: string;
  public readonly instanceEndpoint: Endpoint;
  public readonly secret?: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseInstanceFromSnapshotProps) {
    super(scope, id, props);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (!props.snapshotIdentifier && !props.clusterSnapshotIdentifier) {
      throw new ValidationError('You must specify `snapshotIdentifier` or `clusterSnapshotIdentifier`', this);
    }
    if (props.snapshotIdentifier && props.clusterSnapshotIdentifier) {
      throw new ValidationError('You cannot specify both `snapshotIdentifier` and `clusterSnapshotIdentifier`', this);
    }

    let credentials = props.credentials;
    let secret = credentials?.secret;
    if (!secret && credentials?.generatePassword) {
      if (!credentials.username) {
        throw new ValidationError('`credentials` `username` must be specified when `generatePassword` is set to true', this);
      }

      secret = new DatabaseSecret(this, 'Secret', {
        username: credentials.username,
        encryptionKey: credentials.encryptionKey,
        excludeCharacters: credentials.excludeCharacters,
        replaceOnPasswordCriteriaChanges: credentials.replaceOnPasswordCriteriaChanges,
        replicaRegions: credentials.replicaRegions,
      });
    }

    const instance = new CfnDBInstance(this, 'Resource', {
      ...this.sourceCfnProps,
      dbSnapshotIdentifier: props.snapshotIdentifier,
      dbClusterSnapshotIdentifier: props.clusterSnapshotIdentifier,
      masterUserPassword: secret?.secretValueFromJson('password')?.unsafeUnwrap() ?? credentials?.password?.unsafeUnwrap(), // Safe usage
    });

    this.instanceIdentifier = instance.ref;
    this.dbInstanceEndpointAddress = instance.attrEndpointAddress;
    this.dbInstanceEndpointPort = instance.attrEndpointPort;
    this.instanceResourceId = instance.attrDbiResourceId;

    // create a number token that represents the port of the instance
    const portAttribute = Token.asNumber(instance.attrEndpointPort);
    this.instanceEndpoint = new Endpoint(instance.attrEndpointAddress, portAttribute);

    instance.applyRemovalPolicy(props.removalPolicy ?? RemovalPolicy.SNAPSHOT);

    if (secret) {
      this.secret = secret.attach(this);
    }

    this.setLogRetention();
  }
}

/**
 * Construction properties for a DatabaseInstanceReadReplica.
 */
export interface DatabaseInstanceReadReplicaProps extends DatabaseInstanceNewProps {
  /**
   * The name of the compute and memory capacity classes.
   */
  readonly instanceType: ec2.InstanceType;

  /**
   * The source database instance.
   *
   * Each DB instance can have a limited number of read replicas. For more
   * information, see https://docs.aws.amazon.com/AmazonRDS/latest/DeveloperGuide/USER_ReadRepl.html.
   *
   */
  readonly sourceDatabaseInstance: IDatabaseInstance;

  /**
   * Indicates whether the DB instance is encrypted.
   *
   * @default - true if storageEncryptionKey has been provided, false otherwise
   */
  readonly storageEncrypted?: boolean;

  /**
   * The KMS key that's used to encrypt the DB instance.
   *
   * @default - default master key if storageEncrypted is true, no key otherwise
   */
  readonly storageEncryptionKey?: kms.IKey;
  /**
   * The allocated storage size, specified in gibibytes (GiB).
   *
   * @default - The replica will inherit the allocated storage of the source database instance
   */
  readonly allocatedStorage?: number;
}

/**
 * A read replica database instance.
 *
 * @resource AWS::RDS::DBInstance
 */
@propertyInjectable
export class DatabaseInstanceReadReplica extends DatabaseInstanceNew implements IDatabaseInstance {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-rds.DatabaseInstanceReadReplica';

  public readonly instanceIdentifier: string;
  public readonly dbInstanceEndpointAddress: string;
  public readonly dbInstanceEndpointPort: string;

  /**
   * The AWS Region-unique, immutable identifier for the DB instance.
   * This identifier is found in AWS CloudTrail log entries whenever the AWS KMS key for the DB instance is accessed.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbinstance.html#aws-resource-rds-dbinstance-return-values
   */
  public readonly instanceResourceId?: string;
  public readonly instanceEndpoint: Endpoint;
  public readonly engine?: IInstanceEngine = undefined;
  protected readonly instanceType: ec2.InstanceType;

  constructor(scope: Construct, id: string, props: DatabaseInstanceReadReplicaProps) {
    super(scope, id, props);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (props.sourceDatabaseInstance.engine
        && !props.sourceDatabaseInstance.engine.supportsReadReplicaBackups
        && props.backupRetention) {
      throw new ValidationError(`Cannot set 'backupRetention', as engine '${engineDescription(props.sourceDatabaseInstance.engine)}' does not support automatic backups for read replicas`, this);
    }

    const engineType = props.sourceDatabaseInstance.engine?.engineType;
    if (engineType && props.engineLifecycleSupport && !['mysql', 'postgres'].includes(engineType)) {
      throw new ValidationError(`'engineLifecycleSupport' can only be specified for RDS for MySQL and RDS for PostgreSQL, got: '${engineType}'`, this);
    }

    // The read replica instance always uses the same engine as the source instance
    // but some CF validations require the engine to be explicitly passed when some
    // properties are specified.
    const shouldPassEngine = props.domain != null;

    const instance = new CfnDBInstance(this, 'Resource', {
      ...this.newCfnProps,
      // this must be ARN, not ID, because of https://github.com/terraform-providers/terraform-provider-aws/issues/528#issuecomment-391169012
      sourceDbInstanceIdentifier: props.sourceDatabaseInstance.instanceArn,
      kmsKeyId: props.storageEncryptionKey?.keyArn,
      storageEncrypted: props.storageEncryptionKey ? true : props.storageEncrypted,
      engine: shouldPassEngine ? engineType : undefined,
      allocatedStorage: props.allocatedStorage?.toString(),
    });

    this.instanceType = props.instanceType;
    this.instanceIdentifier = instance.ref;
    this.dbInstanceEndpointAddress = instance.attrEndpointAddress;
    this.dbInstanceEndpointPort = instance.attrEndpointPort;

    this.instanceResourceId = FeatureFlags.of(this).isEnabled(cxapi.USE_CORRECT_VALUE_FOR_INSTANCE_RESOURCE_ID_PROPERTY) ?
      instance.attrDbiResourceId : instance.attrDbInstanceArn;

    // create a number token that represents the port of the instance
    const portAttribute = Token.asNumber(instance.attrEndpointPort);
    this.instanceEndpoint = new Endpoint(instance.attrEndpointAddress, portAttribute);

    instance.applyRemovalPolicy(props.removalPolicy ?? RemovalPolicy.SNAPSHOT);

    this.setLogRetention();
  }
}

/**
 * Renders the processor features specifications
 *
 * @param features the processor features
 */
function renderProcessorFeatures(features: ProcessorFeatures): CfnDBInstance.ProcessorFeatureProperty[] | undefined {
  const featuresList = Object.entries(features).map(([name, value]) => ({ name, value: value.toString() }));

  return featuresList.length === 0 ? undefined : featuresList;
}

function defaultIops(storageType: StorageType, iops?: number): number | undefined {
  switch (storageType) {
    case StorageType.STANDARD:
    case StorageType.GP2:
      return undefined;
    case StorageType.GP3:
      return iops;
    case StorageType.IO1:
    case StorageType.IO2:
      return iops ?? 1000;
  }
}
