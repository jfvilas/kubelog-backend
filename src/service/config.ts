/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { LoggerService, RootConfigService } from '@backstage/backend-plugin-api';
import { KubelogStaticData, KubelogClusterData, KubelogPodPermissions, PodPermissionRule } from '../model/KubelogStaticData';
import { Config } from '@backstage/config';

/**
 * loads kubelogNamespacePermissions setting from app-config xml
 * @param logger Logger service
 * @param cluster Cluster config as it is read form app-config
 * @param kdata KwirtClusterData being processed
 */
const loadNamespacePermissions = (logger:LoggerService, cluster:Config, kdata:KubelogClusterData) => {
    if (cluster.has('kwirthNamespacePermissions') || cluster.has('kubelogNamespacePermissions')) {
        if (cluster.has('kwirthNamespacePermissions')) {
            logger.warn('"kwirthNamespacePermissions" is deprecated, it will be retired on 2025-08-25. Please use name "kubelogNamespacePermissions".')
        }
        logger.info(`Namespace permisson evaluation will be performed for cluster ${cluster.getString('name')}.`);
        var permNamespaces= (cluster.getOptionalConfigArray('kwirthNamespacePermissions') || cluster.getOptionalConfigArray('kubelogNamespacePermissions'))!;
        for (var ns of permNamespaces) {
            var namespace=ns.keys()[0];
            var identityRefs=ns.getStringArray(namespace);
            identityRefs=identityRefs.map(g => g.toLowerCase());
            kdata.namespacePermissions.push ({ namespace, identityRefs })
        }
    }
    else {
        logger.info(`Cluster ${cluster.getString('name')} will have no namespace restrictions.`);
        kdata.namespacePermissions=[];
    }
}

const loadPodRules = (config:Config, id:string) => {
    var rules:PodPermissionRule[]=[];
    for (var rule of config.getConfigArray(id)) {
        var podsStringArray = rule.getOptionalStringArray('pods') || ['.*'];
        var podsRegexArray:RegExp[]=[];
        for (var expr of podsStringArray) {
            podsRegexArray.push(new RegExp(expr));
        }

        var refsStringArray = rule.getOptionalStringArray('refs') || ['.*'];
        var refsRegexArray:RegExp[]=[];
        for (var expr of refsStringArray) {
            refsRegexArray.push(new RegExp(expr));
        }

        var prr:PodPermissionRule={
            pods:podsRegexArray,
            refs:refsRegexArray
        }
        rules.push(prr);
    }
    return rules;
}

/**
 * loads pod log viewing permissions setting from app-config xml
 * @param logger Logger service
 * @param cluster Cluster config as it is read form app-config
 * @param kdata KwirtClusterData being processed
 */
const loadPodPermissions = (configKey:string, logger:LoggerService, cluster:Config) => {
    var clusterPodPermissions:KubelogPodPermissions[]=[];
    if (cluster.has(configKey)) {
        var namespaceList=cluster.getConfigArray(configKey);
        for (var ns of namespaceList) {
            var namespaceName=ns.keys()[0];
            var podPermissions:KubelogPodPermissions={ namespace:namespaceName };

            if (ns.getConfig(namespaceName).has('allow')) podPermissions.allow=loadPodRules(ns.getConfig(namespaceName), 'allow');
            if (ns.getConfig(namespaceName).has('except')) podPermissions.except=loadPodRules(ns.getConfig(namespaceName), 'except');
            if (ns.getConfig(namespaceName).has('deny')) podPermissions.deny=loadPodRules(ns.getConfig(namespaceName), 'deny');
            if (ns.getConfig(namespaceName).has('unless')) podPermissions.unless=loadPodRules(ns.getConfig(namespaceName), 'unless');
            clusterPodPermissions.push(podPermissions);
        }
    }
    else {
        logger.info(`No pod permissions for ${configKey} will be applied for ${cluster.getString('name')} (everyone will be allowed).`);
    }
    return clusterPodPermissions;
}

/**
 * reads app-config and builds a list of valid clusters
 * @param logger core service for logging
 * @param config core service for reading config info
 */
const loadClusters = (logger:LoggerService, config:RootConfigService) => {
    KubelogStaticData.clusterKubelogData.clear();
    var locatingMethods=config.getConfigArray('kubernetes.clusterLocatorMethods');

    locatingMethods.forEach(method => {

      var clusters=(method.getConfigArray('clusters'));

      clusters.forEach(cluster => {

        var clName=cluster.getString('name');
        if ((cluster.has('kwirthHome') || cluster.has('kubelogKwirthHome')) && (cluster.has('kwirthApiKey') || cluster.has('kubelogKwirthApiKey'))) {
            if (cluster.has('kwirthHome')) {
                logger.warn('"kwirthHome" is deprecated, it will be retired on 2025-08-25. Please use name "kubelogHome".');
            }
            if (cluster.has('kwirthApiKey')) {
                logger.warn('"kwirthApiKey" is deprecated, it will be retired on 2025-08-25. Please use name "kubelogApiKey".');
            }
    
            var home=(cluster.getOptionalString('kwirthHome') || cluster.getOptionalString('kubelogKwirthHome'))!;
            var apiKey=(cluster.getOptionalString('kwirthApiKey') || cluster.getOptionalString('kubelogKwirthApiKey'))!;
            var title=(cluster.has('title')?cluster.getString('title'):'No name');
            var kdata:KubelogClusterData={
                home,
                apiKey,
                title,
                namespacePermissions: [],
                viewPermissions: [],
                restartPermissions: []
            };
            logger.info(`Kwirth for ${clName} is located at ${kdata.home}.`);

            // we now read and format permissions according to destination structure inside KubelogClusterData
            loadNamespacePermissions(logger, cluster, kdata);
            kdata.viewPermissions=loadPodPermissions('kubelogPodViewPermissions',logger, cluster);
            kdata.restartPermissions=loadPodPermissions('kubelogPodRestartPermissions', logger, cluster);
            KubelogStaticData.clusterKubelogData.set(clName,kdata);
        }
        else {
            logger.warn(`Cluster ${clName} has no Kwirth information (kubelogHome and kubelogApiKey are missing). It will not be used for Kubelog log viewing.`);
        }
      });
    });
}

export { loadClusters }