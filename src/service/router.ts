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
import express from 'express';
import Router from 'express-promise-router';
import { AuthService, CacheService, DiscoveryService, HttpAuthService, LoggerService, RootConfigService, UrlReaderService, UserInfoService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { UserEntity } from '@backstage/catalog-model';
import { FetchApi } from '@backstage/core-plugin-api';

// Kubelog
import { Pod, Resources } from '@jfvilas/plugin-kubelog-common';

class KubelogStaticData {
  public static clusterKwirthData:Map<string,KwirthClusterData>= new Map();
}

export type KubelogRouterOptions = {
  discovery: DiscoveryService;
  config: RootConfigService;
  reader: UrlReaderService;
  cache: CacheService;
  logger: LoggerService;
  userInfo: UserInfoService;
  auth: AuthService;
  httpAuth: HttpAuthService;
};

type KwirthNamespacePermissions = {
  namespace:string;
  identityRefs:string[]
}
type KwirthClusterData = {
  home: string;
  apiKey: string;
  title: string;
  permissions: KwirthNamespacePermissions[];
}

async function createRouter(options: KubelogRouterOptions): Promise<express.Router> {
  const { config, logger, userInfo, auth, httpAuth, discovery } = options;

  logger.info('Loading static config');

  if (!config.has('kubernetes.clusterLocatorMethods')) {
    logger.error(`Kueblog will not start, there is no 'clusterLocatorMethods' defined in app-confg`);
    throw new Error('Kueblog backend will not be available');
  }
  var methods=config.getConfigArray('kubernetes.clusterLocatorMethods');

  methods.forEach(method => {
    var clusters=(method.getConfigArray('clusters'));
    clusters.forEach(cluster => {
      var clName=cluster.getString('name');
      var kdata:KwirthClusterData={
        home: cluster.getString('kwirthHome'),
        apiKey: cluster.getString('kwirthApiKey'),
        title: cluster.getString('title'),
        permissions: []
      };
      // we now read and format permissions according to destination structure inside KwirthClusterData
      if (cluster.has('kwirthNamespacePermissions')) {
        logger.info(`Namespace permisson evaluation will be performed for cluster ${clName}.`);
        var permNamespaces= cluster.getConfigArray('kwirthNamespacePermissions');
        for (var ns of permNamespaces) {
          var namespace=ns.keys()[0];
          var identityRefs=ns.getStringArray(namespace);
          identityRefs=identityRefs.map(g => g.toLowerCase());
          kdata.permissions.push ({ namespace, identityRefs })
        }
      }
      else {
        logger.info(`Cluster ${clName} will have no namespace restrictions`);
        kdata.permissions=[];
      }
      
      logger.info(`Kwirth for ${clName} is located at ${kdata.home}`);
      KubelogStaticData.clusterKwirthData.set(clName,kdata);
    });
  });

  logger.info('Static config loaded');

  const router = Router();
  router.use(express.json());

  // we need this function to be able to invoke another backend plugin passing a token
  const createAuthFetchApi = (token: string): FetchApi => {
    return {
      fetch: async (input, init) => {
        init = init || {};
        init.headers = {
          ...init.headers,
          Authorization: `Bearer ${token}`,
        };
        return fetch(input, init);
      },
    };
  };    

  const getValidResources = async (entityName:string) => {
    var resourceList:Resources[]=[];

    for (const name of KubelogStaticData.clusterKwirthData.keys()) {
      var url=KubelogStaticData.clusterKwirthData.get(name)?.home as string;
      var apiKey=KubelogStaticData.clusterKwirthData.get(name)?.apiKey;
      var title=KubelogStaticData.clusterKwirthData.get(name)?.title;
      var queryUrl=url+`/managecluster/find?label=backstage.io%2fkubernetes-id&entity=${entityName}`;
      var fetchResp = await fetch (queryUrl, {headers:{'Authorization':'Bearer '+apiKey}});
      var jsonResp=await fetchResp.json();
      if (jsonResp) resourceList.push({ name, url, title, data:jsonResp });
    }

    return resourceList;
  }

  // remove from the resourcesList all the resources user is no authorized to view according to kubelog permissions config
  const applyPermissions = (resourcesList:Resources[], userEntityRef:string, userGroups:string[]) => {
    for (var cluster of resourcesList) {
      var clusterKwirthRules=KubelogStaticData.clusterKwirthData.get(cluster.name)?.permissions;
      var sortList:Pod[]=[];

      for (var pod of cluster.data) {
        var rule=clusterKwirthRules?.find(ns => ns.namespace===pod.namespace);
        if (rule) {
          if (rule.identityRefs.includes(userEntityRef.toLowerCase())) {
            // a user ref has been found
            sortList.push(pod);
          }
          else {
            var joinResult=rule?.identityRefs.filter(identityRef => userGroups.includes(identityRef));
            if (joinResult && joinResult.length>0) {
              // a group ref match has been found
              sortList.push(pod);
            }
          }
        }
        else {
          // no restrictions for this namespace
          sortList.push(pod);
        }
      }
      cluster.data=sortList;
    }
    return resourcesList;
  }

  const getAccessKey = async (clusterName:string, entity:string, resource:string, user:string) => {
    var url=KubelogStaticData.clusterKwirthData.get(clusterName)?.home as string;
    var apiKey=KubelogStaticData.clusterKwirthData.get(clusterName)?.apiKey;

    var payload={ type:'volatile', resource, description:`Backstage API key for user ${user} accessing component ${entity}`, expire:Date.now()+60*60*1000};
    var response=await fetch(url+'/key',{method:'POST', body:JSON.stringify(payload), headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKey}});
    var data=await response.json();
    return data.accessKey;
  }

  router.post('/start', async (req, res) => {
    // obtain basic user info
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const info = await userInfo.getUserInfo(credentials);
    var principal=info.userEntityRef.split(':')[1];
    var username=principal.split('/')[1];

    // connecto to catalog to obtain IAM user info, like group membership (memberOf)
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog'
    });
    const catalogClient = new CatalogClient({
      discoveryApi: discovery,
      fetchApi: createAuthFetchApi(token),
    });
    const entity = await catalogClient.getEntityByRef(info.userEntityRef) as UserEntity;
    var userGroupsRefs:string[]=[];
    if (entity?.spec.memberOf) userGroupsRefs=entity?.spec.memberOf;

    // get a resource list
    var resourcesList:Resources[]=await getValidResources(req.body.metadata.name);

    // remove unauthorized resources (according to group memberships and kubelog config in app-config)
    resourcesList=applyPermissions(resourcesList, info.userEntityRef, userGroupsRefs);

    // remove clusters that contain no pods
    resourcesList=resourcesList.filter(cluster => cluster.data.length>0);

    // obtain apikeys for the final list
    for (const cluster of resourcesList) {
      for (const pod of cluster.data) {
        //+++ TODO: allow selecting a container if the pod has more than one (needs to be implemented also in frontend)
        var resource=`filter:${pod.namespace}::${pod.name}:`;
        pod.accessKey=await getAccessKey(cluster.name, req.body.metadata.name, resource, username);
      }
    }
    res.status(200).send(resourcesList);
  });

  return router;
}

export { createRouter }