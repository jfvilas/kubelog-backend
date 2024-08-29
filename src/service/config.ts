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
import { KubelogStaticData, KwirthClusterData, KwirthPodPermissions } from '../model/KwirthStaticData';
import { Config } from '@backstage/config';

/**
 * loads kwirthNamespacePermissions setting from app-config xml
 * @param logger Logger service
 * @param cluster Cluster config as it is read form app-config
 * @param kdata KwirtClusterData being processed
 */
const loadNamespacePermission = (logger:LoggerService, cluster:Config, kdata:KwirthClusterData) => {
    if (cluster.has('kwirthNamespacePermissions')) {
        logger.info(`Namespace permisson evaluation will be performed for cluster ${cluster.getString('name')}.`);
        var permNamespaces= cluster.getConfigArray('kwirthNamespacePermissions');
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
    var rules=new Map<string,string[]|undefined>();
    for (var rule of config.getConfigArray(id)) {
        var pods=rule.getStringArray('pods');
        var refs=rule.getOptionalStringArray('refs');
        for (var podExpression of pods) {
            rules.set(podExpression,refs);
        }
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
    var clusterPodPermissions:KwirthPodPermissions[]=[];
    if (cluster.has(configKey)) {
        var namespaceList=cluster.getConfigArray(configKey);
        for (var ns of namespaceList) {
            var namespaceName=ns.keys()[0];
            var podPermissions:KwirthPodPermissions={ namespace:namespaceName };

            if (ns.getConfig(namespaceName).has('allow')) podPermissions.allow=loadPodRules(ns.getConfig(namespaceName), 'allow');
            if (ns.getConfig(namespaceName).has('restrict')) podPermissions.restrict=loadPodRules(ns.getConfig(namespaceName), 'restrict');
            if (ns.getConfig(namespaceName).has('deny')) podPermissions.deny=loadPodRules(ns.getConfig(namespaceName), 'deny');
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
    var locatingMethods=config.getConfigArray('kubernetes.clusterLocatorMethods');

    locatingMethods.forEach(method => {

      var clusters=(method.getConfigArray('clusters'));

      clusters.forEach(cluster => {

        var clName=cluster.getString('name');
        if (cluster.has('kwirthHome') && cluster.has('kwirthApiKey')) {
            var kdata:KwirthClusterData={
                home: cluster.getString('kwirthHome'),
                apiKey: cluster.getString('kwirthApiKey'),
                title: (cluster.has('title')?cluster.getString('title'):'No name'),
                namespacePermissions: [],
                viewPermissions: [],
                restartPermissions: []
            };
            logger.info(`Kwirth for ${clName} is located at ${kdata.home}.`);

            // we now read and format permissions according to destination structure inside KwirthClusterData
            loadNamespacePermission(logger, cluster, kdata);
            kdata.viewPermissions=loadPodPermissions('kwirthPodViewPermissions',logger, cluster);
            kdata.restartPermissions=loadPodPermissions('kwirthPodRestartPermissions', logger, cluster);
            KubelogStaticData.clusterKwirthData.set(clName,kdata);
        }
        else {
            logger.warn(`Cluster ${clName} has no Kwirth onformation. Will not be used for Kubelog log viewing`);
        }
      });
    });
}

export { loadClusters }